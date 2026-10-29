import { ROLE_ADMIN, Roles } from '../auth/auth.js';
import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { Checker, likePattern, parseId } from '../common/validation.js';
import { findGuardian, validateDog } from '../guardians/guardians.logic.js';

async function findDog(id: number) {
  const dog = await queryOne(
    `SELECT d.id, d.guardian_id, d.name, d.breed, d.gender, d.age, d.weight::float AS weight,
            d.birthday, d.created_at
       FROM dogs d WHERE d.id = $1`,
    [id],
  );
  if (!dog) throw new NotFoundException('강아지 정보를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
  return dog;
}

@Controller()
export class DogsController {
  /** 강아지 목록 + 이름·견종·보호자 이름 검색 */
  @Get('dogs')
  async list(@Query('q') q?: string, @Query('page') page?: string, @Query('size') size?: string) {
    const like = likePattern(q);
    return listOrAll(
      parsePaging(page, size),
      `SELECT d.id, d.name, d.breed, d.gender, d.age, d.weight::float AS weight,
              g.id AS guardian_id, g.name AS guardian_name, g.phone AS guardian_phone,
              (SELECT MAX(r.groomed_at) FROM grooming_records r WHERE r.dog_id = d.id) AS last_groomed_at
         FROM dogs d
         JOIN guardians g ON g.id = d.guardian_id
        WHERE $1::text IS NULL
           OR d.name ILIKE $1
           OR d.breed ILIKE $1
           OR g.name ILIKE $1
        ORDER BY d.id DESC`,
      [like],
    );
  }

  /** 강아지 상세: 강아지 + 보호자 + 주의사항 이력 + 미용 기록 */
  @Get('dogs/:id')
  async detail(@Param('id') idText: string) {
    const id = parseId(idText);
    const dog: any = await findDog(id);
    const guardian = await findGuardian(dog.guardian_id);
    const notes = await query(
      'SELECT id, content, created_at FROM dog_notes WHERE dog_id = $1 ORDER BY created_at DESC, id DESC',
      [id],
    );
    const records = await query(
      `SELECT r.id, r.groomed_at, r.style, r.price, r.memo, (r.photo_data IS NOT NULL) AS has_photo,
              gr.id AS groomer_id, gr.name AS groomer_name
         FROM grooming_records r
         JOIN groomers gr ON gr.id = r.groomer_id
        WHERE r.dog_id = $1
        ORDER BY r.groomed_at DESC, r.id DESC`,
      [id],
    );
    return { ...dog, guardian, notes, records };
  }

  /** 강아지 정보 수정 (관리사·관리 화면 모두 사용) */
  @Put('dogs/:id')
  async update(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    await findDog(id);
    const { c, value } = validateDog(body);
    c.done();
    return queryOne(
      `UPDATE dogs SET name=$1, breed=$2, gender=$3, age=$4, weight=$5, birthday=$6
        WHERE id=$7 RETURNING id`,
      [value.name, value.breed, value.gender, value.age, value.weight, value.birthday, id],
    );
  }

  /** 삭제는 관리 화면에서만 써요. 주의사항·미용기록도 함께 지워져요. */
  @Roles(ROLE_ADMIN)
  @Delete('dogs/:id')
  async remove(@Param('id') idText: string) {
    const id = parseId(idText);
    await findDog(id);
    const reserved = await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM reservations WHERE dog_id = $1 AND status = '신청'",
      [id],
    );
    if ((reserved?.count ?? 0) > 0) {
      throw new ConflictException('예약이 남아 있는 강아지는 삭제할 수 없어요. 먼저 예약을 취소해 주세요.');
    }
    // 남은 예약은 모두 취소된 기록뿐이라서, 강아지와 함께 지워요.
    await query('DELETE FROM reservations WHERE dog_id = $1', [id]);
    await query('DELETE FROM dogs WHERE id = $1', [id]);
    return { message: '삭제했어요.' };
  }

  /** 주의사항 목록 (날짜 최신순) */
  @Get('dogs/:id/notes')
  async notes(@Param('id') idText: string) {
    const id = parseId(idText);
    await findDog(id);
    return query(
      'SELECT id, content, created_at FROM dog_notes WHERE dog_id = $1 ORDER BY created_at DESC, id DESC',
      [id],
    );
  }

  /** 주의사항 추가. 수정하는 기능은 일부러 만들지 않았어요. */
  @Post('dogs/:id/notes')
  async addNote(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    await findDog(id);
    const c = new Checker();
    const content = c.text(body, 'content', '주의사항', { required: true, max: 300 });
    c.done();
    return queryOne('INSERT INTO dog_notes (dog_id, content) VALUES ($1,$2) RETURNING id, content, created_at', [
      id,
      content,
    ]);
  }

  @Roles(ROLE_ADMIN)
  @Delete('notes/:id')
  async removeNote(@Param('id') idText: string) {
    const id = parseId(idText);
    const found = await queryOne('SELECT id FROM dog_notes WHERE id = $1', [id]);
    if (!found) throw new NotFoundException('주의사항을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    await query('DELETE FROM dog_notes WHERE id = $1', [id]);
    return { message: '삭제했어요.' };
  }
}
