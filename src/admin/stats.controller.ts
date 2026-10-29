import type { AuthUser } from '../auth/auth.js';
import { BadRequestException, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, ROLE_ADMIN, Roles } from '../auth/auth.js';
import { query, queryOne } from '../common/db.js';
import { refillReservations } from '../common/schema.js';
import { kstNow, monthRange, SLOTS } from '../common/time.js';

@Controller()
export class StatsController {
  /** 현황: 오늘 예약 수, 이번 달 예약 건수, 이번 달 매출(사장님에게만) */
  @Get('stats')
  async stats(@CurrentUser() user: AuthUser) {
    const today = kstNow().date;
    const month = monthRange();
    const todayRow = await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM reservations WHERE reserved_date = $1 AND status = '신청'",
      [today],
    );
    const monthRow = await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM reservations WHERE reserved_date >= $1 AND reserved_date < $2 AND status = '신청'",
      [month.from, month.to],
    );
    const result: Record<string, unknown> = {
      today,
      month: month.from.slice(0, 7),
      today_reservations: todayRow?.count ?? 0,
      month_reservations: monthRow?.count ?? 0,
    };
    // 매출은 사장님에게만 보내요. 관리사에게는 값 자체를 보내지 않아요.
    if (user.role === ROLE_ADMIN) {
      const sales = await queryOne<{ total: string }>(
        'SELECT COALESCE(SUM(price), 0)::text AS total FROM grooming_records WHERE groomed_at >= $1 AND groomed_at < $2',
        [month.from, month.to],
      );
      result.month_sales = Number(sales?.total ?? 0);
    }
    return result;
  }

  /**
   * 현황 그래프용 숫자. 현황 카드 하나를 고르면 그 카드의 그래프를 그려요.
   *  - today: 오늘 예약을 30분 시간대별로 센 값
   *  - month: 고른 달의 날짜별 예약 건수 (취소 제외)
   *  - sales: 고른 달의 날짜별 매출 (사장님만)
   */
  @Get('stats/series')
  async series(@CurrentUser() user: AuthUser, @Query('metric') metric?: string, @Query('month') monthText?: string) {
    const thisMonth = kstNow().date.slice(0, 7);
    const monthKey = monthText ?? thisMonth;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
      throw new BadRequestException('달은 2026-10 처럼 적어 주세요.');
    }
    if (metric === 'today') {
      const today = kstNow().date;
      const rows = await query<{ t: string; n: number }>(
        "SELECT reserved_time AS t, COUNT(*)::int AS n FROM reservations WHERE reserved_date = $1 AND status = '신청' GROUP BY 1",
        [today],
      );
      const byTime = new Map(rows.map((r) => [r.t, r.n]));
      const items = SLOTS.map((t) => ({ label: t, value: byTime.get(t) ?? 0 }));
      return { metric, date: today, unit: '건', items, total: items.reduce((a, b) => a + b.value, 0) };
    }
    if (metric !== 'month' && metric !== 'sales') {
      throw new BadRequestException('metric 은 today, month, sales 중 하나여야 해요.');
    }
    if (metric === 'sales' && user.role !== ROLE_ADMIN) {
      throw new ForbiddenException('매출은 사장님만 볼 수 있어요.');
    }
    const first = `${monthKey}-01`;
    const next = new Date(`${first}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const to = next.toISOString().slice(0, 10);
    const days = Math.round((next.getTime() - new Date(`${first}T00:00:00Z`).getTime()) / 86400000);
    const rows =
      metric === 'month'
        ? await query<{ d: string; n: number }>(
            "SELECT reserved_date::text AS d, COUNT(*)::int AS n FROM reservations WHERE reserved_date >= $1 AND reserved_date < $2 AND status = '신청' GROUP BY 1",
            [first, to],
          )
        : await query<{ d: string; n: number }>(
            'SELECT groomed_at::text AS d, COALESCE(SUM(price), 0)::int AS n FROM grooming_records WHERE groomed_at >= $1 AND groomed_at < $2 GROUP BY 1',
            [first, to],
          );
    const byDay = new Map(rows.map((r) => [r.d.slice(0, 10), r.n]));
    const items = Array.from({ length: days }, (_, i) => {
      const date = `${monthKey}-${String(i + 1).padStart(2, '0')}`;
      return { label: String(i + 1), date, value: byDay.get(date) ?? 0 };
    });
    return { metric, month: monthKey, unit: metric === 'sales' ? '원' : '건', items, total: items.reduce((a, b) => a + b.value, 0) };
  }

  /** 가상 데이터 다시 채우기: 예약·AI 사용 기록만 지우고 가상 예약으로 다시 채워요. */
  @Roles(ROLE_ADMIN)
  @Post('admin/reseed')
  async reseed() {
    const created = await refillReservations();
    return { message: '가상 예약 데이터를 다시 채웠어요.', created };
  }
}
