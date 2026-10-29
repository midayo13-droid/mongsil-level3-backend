import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, ROLE_ADMIN, ROLE_STAFF, Roles, type AuthUser } from '../auth/auth.js';
import { query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { MAX_PER_GROOMER_PER_DAY, SLOTS, isValidDate, kstNow } from '../common/time.js';
import { likePattern, parseId } from '../common/validation.js';
import { cancelDeadline, canCancel, cancelReservation, closedReason, createReservation } from './reservations.service.js';

export const LIST_COLUMNS = `
  r.id, r.reserved_date, r.reserved_time, r.style, r.status, r.memo, r.created_at, r.canceled_at,
  d.id AS dog_id, d.name AS dog_name, d.breed AS dog_breed,
  gr.id AS groomer_id, gr.name AS groomer_name,
  u.name AS created_by_name, u.role AS created_by_role`;

export const FROM = `
  FROM reservations r
  JOIN dogs d ON d.id = r.dog_id
  JOIN groomers gr ON gr.id = r.groomer_id
  LEFT JOIN users u ON u.id = r.created_by`;

/** 관리자 화면용 예약 주소 (총관리자·일반관리자). 고객은 /me/... 주소를 써요. */
@Controller('reservations')
@Roles(ROLE_ADMIN, ROLE_STAFF)
export class ReservationsController {
  /** 예약 목록: 날짜 범위·상태·강아지 이름(또는 관리사·스타일) 검색 */
  @Get()
  async list(
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('dog_id') dogId?: string,
    @Query('page') page?: string, @Query('size') size?: string,
  ) {
    const dateOk = (v?: string) => (v && isValidDate(v) ? v : null);
    const dogFilter = dogId && Number.isInteger(Number(dogId)) ? Number(dogId) : null;
    const rows = await listOrAll(
      parsePaging(page, size),
      `SELECT ${LIST_COLUMNS} ${FROM}
        WHERE ($1::text IS NULL OR d.name ILIKE $1 OR gr.name ILIKE $1 OR r.style ILIKE $1)
          AND ($2::date IS NULL OR r.reserved_date >= $2::date)
          AND ($3::date IS NULL OR r.reserved_date <= $3::date)
          AND ($4::text IS NULL OR r.status = $4)
          AND ($5::int IS NULL OR r.dog_id = $5::int)
        ORDER BY r.reserved_date DESC, r.reserved_time DESC, r.id DESC`,
      [likePattern(q), dateOk(from), dateOk(to), status === '신청' || status === '취소' ? status : null, dogFilter],
    );
    const withFlag = (r: any) => ({ ...r, cancelable: canCancel(r.reserved_date, r.status) });
    return Array.isArray(rows) ? rows.map(withFlag) : { ...rows, items: rows.items.map(withFlag) };
  }

  /** 날짜별 시간표: 근무 중인 관리사마다 30분 칸이 비었는지 찬 칸인지 알려 줘요. */
  @Get('board')
  async board(@Query('date') date?: string) {
    const day = date && isValidDate(date) ? date : kstNow().date;
    const closed = await closedReason(day);
    const groomers = await query<{ id: number; name: string }>(
      "SELECT id, name FROM groomers WHERE status = '근무중' ORDER BY id",
    );
    const booked = await query(
      `SELECT r.id, r.groomer_id, r.reserved_time, r.style, d.name AS dog_name
         FROM reservations r JOIN dogs d ON d.id = r.dog_id
        WHERE r.reserved_date = $1 AND r.status = '신청'`,
      [day],
    );
    return {
      date: day,
      closed,
      slots: SLOTS,
      groomers: groomers.map((g) => ({
        ...g,
        count: booked.filter((b: any) => b.groomer_id === g.id).length,
        reservations: booked.filter((b: any) => b.groomer_id === g.id),
      })),
      max_per_groomer: MAX_PER_GROOMER_PER_DAY,
    };
  }

  @Get(':id')
  async detail(@Param('id') idText: string) {
    const id = parseId(idText);
    const row = await queryOne<any>(
      `SELECT ${LIST_COLUMNS}, g.id AS guardian_id, g.name AS guardian_name ${FROM}
         JOIN guardians g ON g.id = d.guardian_id
        WHERE r.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('예약을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    const deadline = cancelDeadline(row.reserved_date);
    return {
      ...row,
      cancelable: canCancel(row.reserved_date, row.status),
      cancel_deadline: `${deadline.date} ${deadline.time}`,
    };
  }

  /** 예약 신청 (관리사가 전화를 받고 입력). 규칙은 고객이 직접 할 때와 똑같이 지켜요. */
  @Post()
  async create(@Body() body: any, @CurrentUser() user: AuthUser) {
    return createReservation(body, user);
  }

  @Post(':id/cancel')
  async cancel(@Param('id') idText: string, @CurrentUser() user: AuthUser) {
    return cancelReservation(parseId(idText), user);
  }
}
