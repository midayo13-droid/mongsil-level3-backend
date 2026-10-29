import { ROLE_ADMIN, Roles } from '../auth/auth.js';
import { Body, ConflictException, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { pool, query, queryOne } from '../common/db.js';
import { Checker, likePattern, parseId } from '../common/validation.js';
import {
  assertPhoneFree,
  findDogs,
  findGuardian,
  validateDog,
  validateGuardian,
} from './guardians.logic.js';

@Controller()
export class GuardiansController {
  /** 고객(보호자) 목록 + 이름·번호 검색 */
  @Get('guardians')
  async list(@Query('q') q?: string) {
    const like = likePattern(q);
    return query(
      `SELECT g.id, g.name, g.phone, g.email, g.created_at,
              (SELECT COUNT(*) FROM dogs d WHERE d.guardian_id = g.id)::int AS dog_count
         FROM guardians g
        WHERE $1::text IS NULL
           OR g.name ILIKE $1
           OR g.phone ILIKE $1
           OR replace(g.phone, '-', '') ILIKE $1
        ORDER BY g.id DESC`,
      [like],
    );
  }

  @Get('guardians/:id')
  async detail(@Param('id') idText: string) {
    const id = parseId(idText);
    const guardian = await findGuardian(id);
    const dogs = await findDogs(id);
    return { ...guardian, dogs };
  }

  /** 보호자만 등록 */
  @Post('guardians')
  async create(@Body() body: any) {
    const { c, value } = validateGuardian(body);
    c.done();
    await assertPhoneFree(value.phone!);
    return queryOne(
      `INSERT INTO guardians (name, phone, email, emergency_name, emergency_phone, message)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [value.name, value.phone, value.email, value.emergency_name, value.emergency_phone, value.message],
    );
  }

  /** 보호자 정보 수정 (관리사 화면, 관리 화면 모두 사용) */
  @Put('guardians/:id')
  async update(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    await findGuardian(id);
    const { c, value } = validateGuardian(body);
    c.done();
    await assertPhoneFree(value.phone!, id);
    return queryOne(
      `UPDATE guardians
          SET name=$1, phone=$2, email=$3, emergency_name=$4, emergency_phone=$5, message=$6
        WHERE id=$7 RETURNING *`,
      [value.name, value.phone, value.email, value.emergency_name, value.emergency_phone, value.message, id],
    );
  }

  /** 삭제는 관리 화면에서만 써요. 강아지가 남아 있으면 막아요. */
  @Roles(ROLE_ADMIN)
  @Delete('guardians/:id')
  async remove(@Param('id') idText: string) {
    const id = parseId(idText);
    await findGuardian(id);
    const [{ count }] = await query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM dogs WHERE guardian_id = $1',
      [id],
    );
    if (count > 0) {
      throw new ConflictException('이 고객에게 등록된 강아지가 있어요. 먼저 강아지를 삭제해 주세요.');
    }
    await query('DELETE FROM guardians WHERE id = $1', [id]);
    return { message: '삭제했어요.' };
  }

  /** 신규 등록: 보호자 1명 + 강아지 1마리 이상을 한 번에 저장 */
  @Post('registrations')
  async register(@Body() body: any) {
    const c = new Checker();
    const g = validateGuardian(body?.guardian ?? {});
    c.merge(g.c, 'guardian.');

    const dogBodies: any[] = Array.isArray(body?.dogs) ? body.dogs : [];
    if (dogBodies.length === 0) {
      c.fail('dogs', '강아지를 한 마리 이상 등록해 주세요.');
    } else if (dogBodies.length > 10) {
      c.fail('dogs', '한 번에 강아지는 10마리까지 등록할 수 있어요.');
    }
    const dogs = dogBodies.slice(0, 10).map((dogBody, index) => {
      const d = validateDog(dogBody);
      c.merge(d.c, `dogs.${index}.`);
      return d.value;
    });
    c.done();
    await assertPhoneFree(g.value.phone!);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const gv = g.value;
      const inserted = await client.query(
        `INSERT INTO guardians (name, phone, email, emergency_name, emergency_phone, message)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [gv.name, gv.phone, gv.email, gv.emergency_name, gv.emergency_phone, gv.message],
      );
      const guardian = inserted.rows[0];
      const dogIds: number[] = [];
      for (const d of dogs) {
        const r = await client.query(
          `INSERT INTO dogs (guardian_id, name, breed, gender, age, weight, birthday)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [guardian.id, d.name, d.breed, d.gender, d.age, d.weight, d.birthday],
        );
        dogIds.push(r.rows[0].id);
        // 처음 적은 특이사항이 있으면 주의사항 첫 글로 남겨요.
      }
      const firstNotes: Array<string | null> = dogBodies.slice(0, 10).map((b) =>
        typeof b?.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 300) : null,
      );
      for (let i = 0; i < dogIds.length; i++) {
        if (firstNotes[i]) {
          await client.query('INSERT INTO dog_notes (dog_id, content) VALUES ($1,$2)', [dogIds[i], firstNotes[i]]);
        }
      }
      await client.query('COMMIT');
      return { guardian_id: guardian.id, dog_ids: dogIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 기존 보호자에게 강아지 추가 */
  @Post('guardians/:id/dogs')
  async addDog(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    await findGuardian(id);
    const { c, value } = validateDog(body);
    c.done();
    const dog = await queryOne<{ id: number }>(
      `INSERT INTO dogs (guardian_id, name, breed, gender, age, weight, birthday)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, value.name, value.breed, value.gender, value.age, value.weight, value.birthday],
    );
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) : '';
    if (note) {
      await query('INSERT INTO dog_notes (dog_id, content) VALUES ($1,$2)', [dog!.id, note]);
    }
    return dog;
  }
}
