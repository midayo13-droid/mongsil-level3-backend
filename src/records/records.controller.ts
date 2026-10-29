import { ROLE_ADMIN, Roles } from '../auth/auth.js';
import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import { query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { Checker, STYLES, likePattern, parseId } from '../common/validation.js';

const LIST_COLUMNS = `
  r.id, r.groomed_at, r.style, r.price, r.memo, (r.photo_data IS NOT NULL) AS has_photo,
  d.id AS dog_id, d.name AS dog_name, d.breed AS dog_breed,
  gr.id AS groomer_id, gr.name AS groomer_name`;

/** 미용기록 입력 검사. 담당 관리사는 "근무중"인 사람만 새로 고를 수 있어요. */
async function validateRecord(body: any, currentGroomerId?: number) {
  const c = new Checker();
  const value = {
    dog_id: c.id(body, 'dog_id', '강아지'),
    groomer_id: c.id(body, 'groomer_id', '담당 관리사'),
    groomed_at: c.date(body, 'groomed_at', '미용 날짜', { required: true }),
    style: c.choice(body, 'style', '스타일', STYLES, true),
    price: c.number(body, 'price', '가격', { required: true, min: 0, max: 10000000, integer: true, unit: '원' }),
    memo: c.text(body, 'memo', '메모', { max: 500 }),
    photo: c.photo(body, 'photo_data'),
  };
  c.done();

  const dog = await queryOne('SELECT id FROM dogs WHERE id = $1', [value.dog_id]);
  if (!dog) c.fail('dog_id', '선택한 강아지를 찾을 수 없어요. 다시 골라 주세요.');

  const groomer = await queryOne<{ status: string }>('SELECT status FROM groomers WHERE id = $1', [value.groomer_id]);
  if (!groomer) {
    c.fail('groomer_id', '선택한 담당 관리사를 찾을 수 없어요. 다시 골라 주세요.');
  } else if (groomer.status !== '근무중' && value.groomer_id !== currentGroomerId) {
    c.fail('groomer_id', '퇴사한 관리사는 새로 고를 수 없어요. 근무 중인 관리사를 골라 주세요.');
  }
  c.done();
  return value;
}

async function findRecord(id: number) {
  const record = await queryOne('SELECT id, groomer_id FROM grooming_records WHERE id = $1', [id]);
  if (!record) throw new NotFoundException('미용 기록을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
  return record as { id: number; groomer_id: number };
}

@Controller('records')
export class RecordsController {
  /** 미용기록 목록. 강아지 이름·담당 관리사·스타일 검색, 날짜 범위, 강아지별 보기 */
  @Get()
  async list(
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('dog_id') dogId?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const like = likePattern(q);
    const dateOk = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const dogFilter = dogId && Number.isInteger(Number(dogId)) ? Number(dogId) : null;
    return listOrAll(
      parsePaging(page, size),
      `SELECT ${LIST_COLUMNS}
         FROM grooming_records r
         JOIN dogs d ON d.id = r.dog_id
         JOIN groomers gr ON gr.id = r.groomer_id
        WHERE ($1::text IS NULL OR d.name ILIKE $1 OR gr.name ILIKE $1 OR r.style ILIKE $1)
          AND ($2::date IS NULL OR r.groomed_at >= $2::date)
          AND ($3::date IS NULL OR r.groomed_at <= $3::date)
          AND ($4::int IS NULL OR r.dog_id = $4::int)
        ORDER BY r.groomed_at DESC, r.id DESC`,
      [like, dateOk(from), dateOk(to), dogFilter],
    );
  }

  @Get(':id')
  async detail(@Param('id') idText: string) {
    const id = parseId(idText);
    const record = await queryOne(
      `SELECT ${LIST_COLUMNS}, g.id AS guardian_id, g.name AS guardian_name
         FROM grooming_records r
         JOIN dogs d ON d.id = r.dog_id
         JOIN guardians g ON g.id = d.guardian_id
         JOIN groomers gr ON gr.id = r.groomer_id
        WHERE r.id = $1`,
      [id],
    );
    if (!record) throw new NotFoundException('미용 기록을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    return record;
  }

  /** 사진은 DB에 저장해 둔 것을 그림 파일로 돌려줘요. */
  @Get(':id/photo')
  async photo(@Param('id') idText: string, @Res() res: any) {
    const id = parseId(idText);
    const row = await queryOne<{ photo_data: string | null }>(
      'SELECT photo_data FROM grooming_records WHERE id = $1',
      [id],
    );
    const match = row?.photo_data ? /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(row.photo_data) : null;
    if (!match) throw new NotFoundException('등록된 사진이 없어요.');
    res.setHeader('Content-Type', match[1]);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(match[2], 'base64'));
  }

  @Post()
  async create(@Body() body: any) {
    const v = await validateRecord(body);
    return queryOne(
      `INSERT INTO grooming_records (dog_id, groomer_id, groomed_at, style, price, memo, photo_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [v.dog_id, v.groomer_id, v.groomed_at, v.style, v.price, v.memo, v.photo],
    );
  }

  /** 사진 칸을 보내지 않으면 기존 사진을 그대로 두고, remove_photo 가 true 면 사진을 지워요. */
  @Roles(ROLE_ADMIN)
  @Put(':id')
  async update(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    const current = await findRecord(id);
    const v = await validateRecord(body, current.groomer_id);
    const removePhoto = body?.remove_photo === true;
    const keepPhoto = !removePhoto && !v.photo;
    return queryOne(
      `UPDATE grooming_records
          SET dog_id=$1, groomer_id=$2, groomed_at=$3, style=$4, price=$5, memo=$6,
              photo_data = CASE WHEN $8::boolean THEN photo_data ELSE $7 END
        WHERE id=$9 RETURNING id`,
      [v.dog_id, v.groomer_id, v.groomed_at, v.style, v.price, v.memo, v.photo, keepPhoto, id],
    );
  }

  @Roles(ROLE_ADMIN)
  @Delete(':id')
  async remove(@Param('id') idText: string) {
    const id = parseId(idText);
    await findRecord(id);
    await query('DELETE FROM grooming_records WHERE id = $1', [id]);
    return { message: '삭제했어요.' };
  }
}

