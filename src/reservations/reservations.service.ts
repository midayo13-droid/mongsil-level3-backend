import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ROLE_CUSTOMER, type AuthUser } from '../auth/auth.js';
import { query, queryOne } from '../common/db.js';
import { syncHolidays } from '../common/schema.js';
import { MAX_PER_GROOMER_PER_DAY, SLOTS, dayOfWeek, kstNow } from '../common/time.js';
import { Checker, STYLES } from '../common/validation.js';

/** 고객이 동시에 가질 수 있는 앞으로의 예약 수 (R-10) */
export const CUSTOMER_ACTIVE_LIMIT = 5;

/** 예약 취소가 가능한 마지막 시각: 예약 당일 00:00 (예: 10월 30일 예약은 10월 30일 00:00까지) */
export function cancelDeadline(reservedDate: string) {
  return { date: reservedDate, time: '00:00' };
}

export function canCancel(reservedDate: string, status: string) {
  if (status !== '신청') return false;
  const now = kstNow();
  const deadline = cancelDeadline(reservedDate);
  return `${now.date} ${now.time}` < `${deadline.date} ${deadline.time}`;
}

/** 쉬는 날이면 이유를 돌려줘요. (일요일은 항상 휴무, 그 밖에는 휴무일 목록) */
export async function closedReason(date: string): Promise<string | null> {
  if (dayOfWeek(date) === 0) return '일요일';
  await syncHolidays(Number(date.slice(0, 4))); // 아직 안 불러온 해면 공휴일을 먼저 불러와요
  const row = await queryOne<{ name: string }>('SELECT name FROM closed_days WHERE closed_date = $1', [date]);
  return row?.name ?? null;
}

/**
 * 날짜 하나의 시간별 예약 가능 여부. 고객 예약 화면에서 "눌러서 고를 수 있는 시간"을 보여 줄 때 써요.
 * groomerId 가 있으면 그 관리사만, 없으면 "아무 관리사나 비어 있는 시간"을 가능으로 봐요.
 */
export async function availability(date: string, groomerId: number | null) {
  const closed = await closedReason(date);
  const groomers = await query<{ id: number; name: string }>(
    "SELECT id, name FROM groomers WHERE status = '근무중' ORDER BY id",
  );
  const booked = await query<{ groomer_id: number; reserved_time: string }>(
    "SELECT groomer_id, reserved_time FROM reservations WHERE reserved_date = $1 AND status = '신청'",
    [date],
  );
  const now = kstNow();
  const countOf = (id: number) => booked.filter((b) => b.groomer_id === id).length;
  return {
    date,
    closed,
    slots: SLOTS.map((time) => {
      const past = date < now.date || (date === now.date && time <= now.time);
      const free = groomers
        .filter(
          (g) =>
            (!groomerId || g.id === groomerId) &&
            countOf(g.id) < MAX_PER_GROOMER_PER_DAY &&
            !booked.some((b) => b.groomer_id === g.id && b.reserved_time === time),
        )
        .map((g) => g.id);
      return { time, available: !closed && !past && free.length > 0, groomer_ids: free };
    }),
  };
}

/**
 * 예약 신청. 규칙 R-1~R-6, R-8~R-10 을 모두 여기서 검사해요. (관리사가 입력할 때와 고객이 직접 할 때 똑같아요)
 * groomer_id 가 "auto" 이면 서버가 가장 한가한 관리사를 정해요. (R-8)
 */
export async function createReservation(body: any, user: AuthUser) {
  const isCustomer = user.role === ROLE_CUSTOMER;
  const c = new Checker();
  const dogId = c.id(body, 'dog_id', '강아지');
  const auto = body?.groomer_id === 'auto';
  const groomerId = auto ? null : c.id(body, 'groomer_id', '담당 관리사');
  const date = c.date(body, 'reserved_date', '예약 날짜', { required: true });
  const time = c.choice(body, 'reserved_time', '예약 시간', SLOTS, true);
  const style = c.choice(body, 'style', '희망 스타일', STYLES, true);
  const memo = c.text(body, 'memo', '요청 메모', { max: 300 });
  c.done();

  const dog = await queryOne<{ id: number; name: string; guardian_id: number }>(
    'SELECT id, name, guardian_id FROM dogs WHERE id = $1',
    [dogId],
  );
  // R-9: 고객은 자기 강아지로만 예약해요.
  if (!dog || (isCustomer && dog.guardian_id !== user.guardian_id)) {
    c.fail('dog_id', isCustomer ? '내 강아지만 예약할 수 있어요.' : '선택한 강아지를 찾을 수 없어요. 다시 골라 주세요.');
  }
  let groomer: { id: number; name: string; status: string } | null = null;
  if (!auto) {
    groomer = await queryOne('SELECT id, name, status FROM groomers WHERE id = $1', [groomerId]);
    if (!groomer) c.fail('groomer_id', '선택한 관리사를 찾을 수 없어요. 다시 골라 주세요.');
    else if (groomer.status !== '근무중') c.fail('groomer_id', '퇴사한 관리사는 고를 수 없어요. 근무 중인 관리사를 골라 주세요.'); // R-6
  }
  c.done();

  // R-3: 일요일·휴무일
  if (dayOfWeek(date!) === 0) {
    c.fail('reserved_date', '일요일은 쉬는 날이에요. 다른 날짜를 골라 주세요.');
  } else {
    const reason = await closedReason(date!);
    if (reason) c.fail('reserved_date', `그날은 쉬는 날이에요(${reason}). 다른 날짜를 골라 주세요.`);
  }
  // R-4: 지난 날짜·시간
  const now = kstNow();
  if (`${date} ${time}` <= `${now.date} ${now.time}`) {
    c.fail(c.errors.reserved_date ? 'reserved_time' : 'reserved_date', '이미 지난 시간이에요. 오늘 이후로 골라 주세요.');
  }
  c.done();

  // R-10: 고객은 앞으로의 예약을 동시에 5건까지
  if (isCustomer) {
    const active = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reservations r JOIN dogs d ON d.id = r.dog_id
        WHERE d.guardian_id = $1 AND r.status = '신청'
          AND (r.reserved_date > $2 OR (r.reserved_date = $2 AND r.reserved_time > $3))`,
      [user.guardian_id, now.date, now.time],
    );
    if ((active?.count ?? 0) >= CUSTOMER_ACTIVE_LIMIT) {
      c.fail('dog_id', `예약은 한 번에 ${CUSTOMER_ACTIVE_LIMIT}건까지 할 수 있어요. 지난 예약이 끝나거나 취소한 뒤에 다시 해 주세요.`);
    }
  }
  // R-2: 같은 강아지·같은 날
  const sameDog = await queryOne(
    "SELECT id FROM reservations WHERE dog_id = $1 AND reserved_date = $2 AND status = '신청'",
    [dogId, date],
  );
  if (sameDog) c.fail('dog_id', `${dog!.name}는 그날 이미 예약이 있어요.`);

  if (auto) {
    // R-8: 그 시간에 비어 있고 그날 6건 미만인 관리사 중, 그날 예약이 가장 적은 사람(같으면 번호가 앞선 사람)
    const rows = await query<{ id: number; name: string; cnt: number; taken: boolean }>(
      `SELECT g.id, g.name,
              (SELECT COUNT(*) FROM reservations r WHERE r.groomer_id = g.id AND r.reserved_date = $1 AND r.status = '신청')::int AS cnt,
              EXISTS (SELECT 1 FROM reservations r WHERE r.groomer_id = g.id AND r.reserved_date = $1
                       AND r.reserved_time = $2 AND r.status = '신청') AS taken
         FROM groomers g WHERE g.status = '근무중' ORDER BY g.id`,
      [date, time],
    );
    const pick = rows
      .filter((r) => !r.taken && r.cnt < MAX_PER_GROOMER_PER_DAY)
      .sort((a, b) => a.cnt - b.cnt || a.id - b.id)[0];
    if (!pick) c.fail('reserved_time', '그 시간에는 예약할 수 있는 관리사가 없어요. 다른 시간을 골라 주세요.');
    else groomer = { id: pick.id, name: pick.name, status: '근무중' };
  } else {
    // R-1: 같은 관리사·같은 시간
    const sameSlot = await queryOne(
      "SELECT id FROM reservations WHERE groomer_id = $1 AND reserved_date = $2 AND reserved_time = $3 AND status = '신청'",
      [groomerId, date, time],
    );
    if (sameSlot) {
      c.fail('reserved_time', `그 시간에는 ${groomer!.name} 관리사가 이미 예약이 있어요. 다른 시간이나 관리사를 골라 주세요.`);
    }
    // R-5: 관리사 하루 최대 6건
    const [{ count }] = await query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM reservations WHERE groomer_id = $1 AND reserved_date = $2 AND status = '신청'",
      [groomerId, date],
    );
    if (count >= MAX_PER_GROOMER_PER_DAY && !c.errors.reserved_time) {
      c.fail('groomer_id', `${groomer!.name} 관리사는 그날 예약이 가득 찼어요(최대 ${MAX_PER_GROOMER_PER_DAY}건).`);
    }
  }
  c.done();

  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO reservations (dog_id, groomer_id, reserved_date, reserved_time, style, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [dogId, groomer!.id, date, time, style, memo, user.id],
    );
    return { id: row!.id, groomer_id: groomer!.id, groomer_name: groomer!.name };
  } catch (error: any) {
    // 동시에 같은 칸을 신청한 경우(DB가 마지막으로 막아 줘요)
    if (error?.code === '23505') {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: { reserved_time: '방금 다른 사람이 같은 칸을 신청했어요. 다른 시간을 골라 주세요.' },
      });
    }
    throw error;
  }
}

/** 예약 취소. R-7: 예약 당일 00:00까지만. 고객은 자기 예약만 취소할 수 있어요. (R-9) */
export async function cancelReservation(id: number, user: AuthUser) {
  const row = await queryOne<{ id: number; reserved_date: string; status: string; guardian_id: number }>(
    `SELECT r.id, r.reserved_date, r.status, d.guardian_id
       FROM reservations r JOIN dogs d ON d.id = r.dog_id WHERE r.id = $1`,
    [id],
  );
  if (!row) throw new NotFoundException('예약을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
  if (user.role === ROLE_CUSTOMER && row.guardian_id !== user.guardian_id) {
    throw new ForbiddenException('내 예약만 취소할 수 있어요.');
  }
  if (row.status === '취소') throw new ConflictException('이미 취소된 예약이에요.');
  if (!canCancel(row.reserved_date, row.status)) {
    throw new ConflictException('예약 당일 00시가 지나서 취소할 수 없어요. 매장으로 전화해 주세요.');
  }
  await query("UPDATE reservations SET status = '취소', canceled_at = now() WHERE id = $1", [id]);
  return { message: '예약을 취소했어요.' };
}
