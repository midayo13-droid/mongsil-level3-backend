import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { ALL_ROLES, ROLE_ADMIN, Roles } from '../auth/auth.js';
import { query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { syncHolidays } from '../common/schema.js';
import { kstNow } from '../common/time.js';
import { Checker, parseId } from '../common/validation.js';

/** 휴무일(일요일 외에 쉬는 날). 일요일은 따로 등록하지 않아도 항상 휴무예요. */
@Controller('closed-days')
export class ClosedDaysController {
  @Roles(...ALL_ROLES)
  @Get()
  list(@Query('page') page?: string, @Query('size') size?: string) {
    return listOrAll(parsePaging(page, size), 'SELECT id, closed_date, name, source FROM closed_days ORDER BY closed_date DESC');
  }

  /** 공휴일 API에서 올해·내년 공휴일을 다시 불러와요. (이미 있는 날짜는 그대로 둬요) */
  @Roles(ROLE_ADMIN)
  @Post('sync')
  async sync() {
    const year = Number(kstNow().date.slice(0, 4));
    const a = await syncHolidays(year, true);
    const b = await syncHolidays(year + 1, true);
    if (!a.ok && !b.ok) {
      throw new ServiceUnavailableException('지금은 공휴일을 불러올 수 없어요. 잠시 뒤 다시 해 주세요.');
    }
    return { message: `공휴일을 불러왔어요. 새로 ${a.added + b.added}일이 추가됐어요.`, added: a.added + b.added };
  }

  @Roles(ROLE_ADMIN)
  @Post()
  async create(@Body() body: any) {
    const c = new Checker();
    const date = c.date(body, 'closed_date', '휴무 날짜', { required: true });
    const name = c.text(body, 'name', '이름', { required: true, max: 30 });
    c.done();
    const exists = await queryOne('SELECT id FROM closed_days WHERE closed_date = $1', [date]);
    if (exists) {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: { closed_date: '이미 등록된 휴무일이에요.' },
      });
    }
    return queryOne('INSERT INTO closed_days (closed_date, name) VALUES ($1,$2) RETURNING id, closed_date, name, source', [date, name]);
  }

  @Roles(ROLE_ADMIN)
  @Delete(':id')
  async remove(@Param('id') idText: string) {
    const rows = await query('DELETE FROM closed_days WHERE id = $1 RETURNING id', [parseId(idText)]);
    if (rows.length === 0) throw new NotFoundException('휴무일을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    return { message: '삭제했어요.' };
  }
}
