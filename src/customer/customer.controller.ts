import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Put, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CurrentUser, ROLE_CUSTOMER, Roles, type AuthUser } from '../auth/auth.js';
import { query, queryOne } from '../common/db.js';
import { isValidDate, kstNow } from '../common/time.js';
import { Checker, parseId } from '../common/validation.js';
import { assertPhoneFree, validateDog, validateGuardian } from '../guardians/guardians.logic.js';
import { FROM, LIST_COLUMNS } from '../reservations/reservations.controller.js';
import {
  availability,
  cancelDeadline,
  canCancel,
  cancelReservation,
  createReservation,
} from '../reservations/reservations.service.js';

const MAX_DOGS_PER_CUSTOMER = 10;

/** 내 강아지만 열 수 있어요. 남의 강아지 번호를 넣으면 서버가 거절해요. (R-9) */
async function ownDog(user: AuthUser, id: number) {
  const dog = await queryOne<any>(
    `SELECT id, guardian_id, name, breed, gender, age, weight::float AS weight, birthday
       FROM dogs WHERE id = $1 AND guardian_id = $2`,
    [id, user.guardian_id],
  );
  if (!dog) throw new ForbiddenException('내 강아지만 볼 수 있어요.');
  return dog;
}

/** 고객용 주소 모음. 모든 주소가 "내 보호자·내 강아지·내 예약"으로만 좁혀져 있어요. */
@Controller('me')
@Roles(ROLE_CUSTOMER)
export class CustomerController {
  /* ---------- 내 정보 ---------- */

  @Get()
  async profile(@CurrentUser() user: AuthUser) {
    const guardian = await queryOne('SELECT * FROM guardians WHERE id = $1', [user.guardian_id]);
    return { user, guardian };
  }

  @Put('profile')
  async updateProfile(@Body() body: any, @CurrentUser() user: AuthUser) {
    const { c, value } = validateGuardian(body);
    c.done();
    await assertPhoneFree(value.phone!, user.guardian_id!);
    const guardian = await queryOne(
      `UPDATE guardians SET name=$1, phone=$2, email=$3, emergency_name=$4, emergency_phone=$5, message=$6
        WHERE id=$7 RETURNING *`,
      [value.name, value.phone, value.email, value.emergency_name, value.emergency_phone, value.message, user.guardian_id],
    );
    await query('UPDATE users SET name = $1 WHERE id = $2', [value.name, user.id]);
    return guardian;
  }

  @Put('password')
  async changePassword(@Body() body: any, @CurrentUser() user: AuthUser) {
    const c = new Checker();
    const current = typeof body?.current_password === 'string' ? body.current_password : '';
    const next = typeof body?.new_password === 'string' ? body.new_password : '';
    if (!current) c.fail('current_password', '지금 쓰는 비밀번호를 적어 주세요.');
    if (!next) c.fail('new_password', '새 비밀번호를 적어 주세요.');
    else if (next.length < 8) c.fail('new_password', '비밀번호는 8자 이상으로 적어 주세요.');
    else if (next.length > 50) c.fail('new_password', '비밀번호는 50자 이내로 적어 주세요.');
    c.done();
    const row = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!row || !(await bcrypt.compare(current, row.password_hash))) {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: { current_password: '지금 쓰는 비밀번호가 맞지 않아요.' },
      });
    }
    if (current === next) c.fail('new_password', '지금 쓰는 비밀번호와 다른 비밀번호로 적어 주세요.');
    c.done();
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 10), user.id]);
    return { message: '비밀번호를 바꿨어요.' };
  }

  /* ---------- 내 강아지 ---------- */

  @Get('dogs')
  dogs(@CurrentUser() user: AuthUser) {
    return query(
      `SELECT d.id, d.name, d.breed, d.gender, d.age, d.weight::float AS weight, d.birthday,
              (SELECT MAX(r.groomed_at) FROM grooming_records r WHERE r.dog_id = d.id) AS last_groomed_at
         FROM dogs d WHERE d.guardian_id = $1 ORDER BY d.id`,
      [user.guardian_id],
    );
  }

  /** 내 강아지 상세: 정보 + 주의사항(보기만) + 미용 이력(보기만) */
  @Get('dogs/:id')
  async dog(@Param('id') idText: string, @CurrentUser() user: AuthUser) {
    const id = parseId(idText);
    const dog = await ownDog(user, id);
    const notes = await query(
      'SELECT id, content, created_at FROM dog_notes WHERE dog_id = $1 ORDER BY created_at DESC, id DESC',
      [id],
    );
    const records = await query(
      `SELECT r.id, r.groomed_at, r.style, r.price, r.memo, gr.name AS groomer_name
         FROM grooming_records r JOIN groomers gr ON gr.id = r.groomer_id
        WHERE r.dog_id = $1 ORDER BY r.groomed_at DESC, r.id DESC`,
      [id],
    );
    return { ...dog, notes, records };
  }

  @Post('dogs')
  async addDog(@Body() body: any, @CurrentUser() user: AuthUser) {
    const { c, value } = validateDog(body);
    c.done();
    const [{ count }] = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM dogs WHERE guardian_id = $1', [
      user.guardian_id,
    ]);
    if (count >= MAX_DOGS_PER_CUSTOMER) {
      throw new BadRequestException({
        message: `강아지는 ${MAX_DOGS_PER_CUSTOMER}마리까지 등록할 수 있어요.`,
        errors: { name: `강아지는 ${MAX_DOGS_PER_CUSTOMER}마리까지 등록할 수 있어요.` },
      });
    }
    return queryOne(
      `INSERT INTO dogs (guardian_id, name, breed, gender, age, weight, birthday)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [user.guardian_id, value.name, value.breed, value.gender, value.age, value.weight, value.birthday],
    );
  }

  @Put('dogs/:id')
  async updateDog(@Param('id') idText: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    const id = parseId(idText);
    await ownDog(user, id);
    const { c, value } = validateDog(body);
    c.done();
    return queryOne(
      `UPDATE dogs SET name=$1, breed=$2, gender=$3, age=$4, weight=$5, birthday=$6 WHERE id=$7 RETURNING id`,
      [value.name, value.breed, value.gender, value.age, value.weight, value.birthday, id],
    );
  }

  /* ---------- 예약 ---------- */

  /** 예약 화면에서 고를 수 있는 관리사 (이름만. 전화번호 같은 정보는 보내지 않아요) */
  @Get('groomers')
  groomers() {
    return query("SELECT id, name FROM groomers WHERE status = '근무중' ORDER BY id");
  }

  /** 날짜를 고르면 시간별로 눌러서 고를 수 있는지 알려 줘요. */
  @Get('availability')
  availability(@Query('date') date?: string, @Query('groomer_id') groomerId?: string) {
    const day = date && isValidDate(date) ? date : kstNow().date;
    const g = groomerId && Number.isInteger(Number(groomerId)) ? Number(groomerId) : null;
    return availability(day, g);
  }

  private async myReservations(user: AuthUser) {
    const rows = await query<any>(
      `SELECT ${LIST_COLUMNS} ${FROM} WHERE d.guardian_id = $1
        ORDER BY r.reserved_date, r.reserved_time, r.id`,
      [user.guardian_id],
    );
    const now = kstNow();
    const withFlags = rows.map((r) => ({ ...r, cancelable: canCancel(r.reserved_date, r.status) }));
    const isFuture = (r: any) => `${r.reserved_date} ${r.reserved_time}` > `${now.date} ${now.time}`;
    return {
      upcoming: withFlags.filter((r) => r.status === '신청' && isFuture(r)),
      past: withFlags.filter((r) => r.status === '신청' && !isFuture(r)).reverse(),
      canceled: withFlags.filter((r) => r.status === '취소').reverse(),
    };
  }

  /** 내 예약: 다가오는 예약 / 지난 예약 / 취소한 예약 */
  @Get('reservations')
  reservations(@CurrentUser() user: AuthUser) {
    return this.myReservations(user);
  }

  @Get('reservations/:id')
  async reservation(@Param('id') idText: string, @CurrentUser() user: AuthUser) {
    const id = parseId(idText);
    const row = await queryOne<any>(`SELECT ${LIST_COLUMNS} ${FROM} WHERE r.id = $1 AND d.guardian_id = $2`, [
      id,
      user.guardian_id,
    ]);
    if (!row) throw new ForbiddenException('내 예약만 볼 수 있어요.');
    const deadline = cancelDeadline(row.reserved_date);
    return { ...row, cancelable: canCancel(row.reserved_date, row.status), cancel_deadline: `${deadline.date} ${deadline.time}` };
  }

  /** 예약 신청: 신청하면 바로 확정이에요. groomer_id 에 "auto" 를 보내면 서버가 관리사를 정해요. */
  @Post('reservations')
  create(@Body() body: any, @CurrentUser() user: AuthUser) {
    return createReservation(body, user);
  }

  @Post('reservations/:id/cancel')
  cancel(@Param('id') idText: string, @CurrentUser() user: AuthUser) {
    return cancelReservation(parseId(idText), user);
  }

  /* ---------- 내 홈 ---------- */

  @Get('summary')
  async summary(@CurrentUser() user: AuthUser) {
    const mine = await this.myReservations(user);
    const dogs = await query(
      'SELECT id, name, breed, gender, age FROM dogs WHERE guardian_id = $1 ORDER BY id',
      [user.guardian_id],
    );
    const notices = await query(
      `SELECT n.id, n.title, n.created_at, (SELECT COUNT(*)::int FROM notice_files f WHERE f.notice_id = n.id) AS file_count
         FROM notices n ORDER BY n.created_at DESC, n.id DESC LIMIT 3`,
    );
    const events = await query(
      `SELECT e.id, e.title, e.start_date, e.end_date, (CURRENT_DATE BETWEEN e.start_date AND e.end_date) AS ongoing,
         (x.image_data IS NOT NULL) AS has_image
         FROM events e LEFT JOIN event_extras x ON x.event_id = e.id
         ORDER BY (CURRENT_DATE BETWEEN e.start_date AND e.end_date) DESC, e.start_date DESC LIMIT 3`,
    );
    return { upcoming: mine.upcoming.slice(0, 3), upcoming_count: mine.upcoming.length, dogs, notices, events };
  }
}

