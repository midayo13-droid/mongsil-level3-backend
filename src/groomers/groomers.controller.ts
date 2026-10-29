import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CurrentUser, ROLE_ADMIN, ROLE_STAFF, Roles, type AuthUser } from '../auth/auth.js';
import { pool, query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { Checker, GROOMER_STATUSES, likePattern, parseId } from '../common/validation.js';

/** 관리사 입력 검사. account 를 보내면 로그인 계정도 함께 만들어요. */
function validateGroomer(body: any, opts: { accountOptional: boolean; hasAccount?: boolean }) {
  const c = new Checker();
  const value = {
    name: c.text(body, 'name', '이름', { required: true, min: 2, max: 20 }),
    phone: c.phone(body, 'phone', '휴대폰 번호', true),
    status: c.choice(body, 'status', '근무 상태', GROOMER_STATUSES, true),
  };

  const acc = body?.account && typeof body.account === 'object' ? body.account : null;
  let account: { username: string; password: string } | null = null;
  let newPassword: string | null = null;

  if (acc && !opts.hasAccount) {
    // 새 계정 만들기: 아이디·비밀번호를 모두 받아요.
    const username = typeof acc.username === 'string' ? acc.username.trim() : '';
    const password = typeof acc.password === 'string' ? acc.password : '';
    if (!username) c.fail('account.username', '아이디를 꼭 적어 주세요.');
    else if (username.length < 4 || username.length > 20) c.fail('account.username', '아이디는 4~20자로 적어 주세요.');
    else if (!/^[A-Za-z0-9]+$/.test(username)) c.fail('account.username', '아이디는 영문과 숫자만 쓸 수 있어요.');
    if (!password) c.fail('account.password', '비밀번호를 꼭 적어 주세요.');
    else if (password.length < 8) c.fail('account.password', '비밀번호는 8자 이상으로 적어 주세요.');
    else if (password.length > 50) c.fail('account.password', '비밀번호는 50자 이내로 적어 주세요.');
    account = { username, password };
  } else if (acc && opts.hasAccount && typeof acc.password === 'string' && acc.password !== '') {
    // 이미 계정이 있으면 아이디는 바꿀 수 없고, 비밀번호만 새로 정할 수 있어요.
    if (acc.password.length < 8) c.fail('account.password', '비밀번호는 8자 이상으로 적어 주세요.');
    else if (acc.password.length > 50) c.fail('account.password', '비밀번호는 50자 이내로 적어 주세요.');
    newPassword = acc.password;
  }
  c.done();
  return { ...value, account, newPassword };
}

async function findGroomer(id: number) {
  const groomer = await queryOne('SELECT * FROM groomers WHERE id = $1', [id]);
  if (!groomer) throw new NotFoundException('관리사 정보를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
  return groomer;
}

/** 새 로그인 계정을 만들어요. (일반관리자 역할, 이 관리사와 1:1 연결) */
async function insertAccount(client: any, groomerId: number, name: string, account: { username: string; password: string }) {
  const taken = await client.query('SELECT id FROM users WHERE username = $1', [account.username]);
  if (taken.rows.length > 0) {
    throw new BadRequestException({
      message: '입력한 내용을 다시 확인해 주세요.',
      errors: { 'account.username': '이미 쓰고 있는 아이디예요. 다른 아이디를 적어 주세요.' },
    });
  }
  await client.query('INSERT INTO users (username, password_hash, name, role, groomer_id) VALUES ($1,$2,$3,$4,$5)', [
    account.username,
    await bcrypt.hash(account.password, 10),
    name,
    ROLE_STAFF,
    groomerId,
  ]);
}

/**
 * 관리사 한 사람을 한 번만 등록해요. 등록할 때 로그인 계정을 함께 만들 수 있어요.
 * 관리사와 일반관리자(관리사) 계정은 같은 사람이라서 1:1 로 이어져요.
 */
@Controller('groomers')
export class GroomersController {
  /** 관리사 목록 + 이름 검색 (status=근무중 으로 근무 중인 사람만). 로그인 아이디는 총관리자에게만 보여요. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('q') q?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('size') size?: string) {
    const like = likePattern(q);
    const rows = await listOrAll<any>(
      parsePaging(page, size),
      `SELECT g.id, g.name, g.phone, g.status, g.created_at,
              (SELECT COUNT(*) FROM grooming_records r WHERE r.groomer_id = g.id)::int AS record_count,
              (SELECT COUNT(*) FROM reservations v WHERE v.groomer_id = g.id AND v.status = '신청')::int AS reservation_count,
              u.id AS account_id, u.username AS account_username
         FROM groomers g
         LEFT JOIN users u ON u.groomer_id = g.id
        WHERE ($1::text IS NULL OR g.name ILIKE $1)
          AND ($2::text IS NULL OR g.status = $2)
        ORDER BY (g.status = '근무중') DESC, g.id`,
      [like, GROOMER_STATUSES.includes(status ?? '') ? status : null],
    );
    if (user.role === ROLE_ADMIN) return rows;
    // 일반관리자에게는 계정이 있는지 없는지만 알려 줘요.
    const hide = ({ account_username, ...rest }: any) => ({ ...rest, has_account: !!rest.account_id });
    return Array.isArray(rows) ? rows.map(hide) : { ...rows, items: rows.items.map(hide) };
  }

  @Get(':id')
  async detail(@Param('id') idText: string) {
    return findGroomer(parseId(idText));
  }

  /** 관리사 상세 화면용: 기본 정보 + 로그인 계정 + 건수 + 최근 미용 기록 + 앞으로의 예약 (사장님 전용) */
  @Roles(ROLE_ADMIN)
  @Get(':id/overview')
  async overview(@Param('id') idText: string) {
    const id = parseId(idText);
    const groomer = await queryOne<any>(
      `SELECT g.id, g.name, g.phone, g.status, g.created_at,
              u.id AS account_id, u.username AS account_username, u.created_at AS account_created_at
         FROM groomers g LEFT JOIN users u ON u.groomer_id = g.id
        WHERE g.id = $1`,
      [id],
    );
    if (!groomer) throw new NotFoundException('관리사를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    const [counts, records, upcoming] = await Promise.all([
      queryOne<any>(
        `SELECT (SELECT COUNT(*) FROM grooming_records WHERE groomer_id = $1)::int AS record_count,
                (SELECT COUNT(*) FROM reservations WHERE groomer_id = $1 AND status = '신청')::int AS reservation_count,
                (SELECT COUNT(*) FROM reservations WHERE groomer_id = $1 AND status = '신청' AND reserved_date >= CURRENT_DATE)::int AS upcoming_count`,
        [id],
      ),
      query(
        `SELECT r.id, r.groomed_at, r.style, r.price, d.name AS dog_name
           FROM grooming_records r JOIN dogs d ON d.id = r.dog_id
          WHERE r.groomer_id = $1 ORDER BY r.groomed_at DESC, r.id DESC LIMIT 5`,
        [id],
      ),
      query(
        `SELECT v.id, v.reserved_date, v.reserved_time, v.style, d.name AS dog_name
           FROM reservations v JOIN dogs d ON d.id = v.dog_id
          WHERE v.groomer_id = $1 AND v.status = '신청' AND v.reserved_date >= CURRENT_DATE
          ORDER BY v.reserved_date, v.reserved_time LIMIT 5`,
        [id],
      ),
    ]);
    return { ...groomer, ...counts, recent_records: records, upcoming_reservations: upcoming };
  }

  /** 등록: account 를 함께 보내면 로그인 계정도 같이 만들어요. 둘 중 하나라도 실패하면 아무것도 저장하지 않아요. */
  @Roles(ROLE_ADMIN)
  @Post()
  async create(@Body() body: any) {
    const v = validateGroomer(body, { accountOptional: true });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const groomer = (
        await client.query('INSERT INTO groomers (name, phone, status) VALUES ($1,$2,$3) RETURNING *', [v.name, v.phone, v.status])
      ).rows[0];
      if (v.account) await insertAccount(client, groomer.id, v.name!, v.account);
      await client.query('COMMIT');
      return { ...groomer, account_created: !!v.account };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 수정: 이름·번호·근무 상태. 계정이 없으면 account 로 새로 만들 수 있고, 있으면 비밀번호만 새로 정할 수 있어요. */
  @Roles(ROLE_ADMIN)
  @Put(':id')
  async update(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    await findGroomer(id);
    const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE groomer_id = $1', [id]);
    const v = validateGroomer(body, { accountOptional: true, hasAccount: !!existing });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const groomer = (
        await client.query('UPDATE groomers SET name=$1, phone=$2, status=$3 WHERE id=$4 RETURNING *', [v.name, v.phone, v.status, id])
      ).rows[0];
      if (existing) {
        // 관리사 이름이 바뀌면 계정에 보이는 이름도 같이 바꿔요.
        await client.query('UPDATE users SET name = $1 WHERE id = $2', [v.name, existing.id]);
        if (v.newPassword) {
          await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(v.newPassword, 10), existing.id]);
        }
      } else if (v.account) {
        await insertAccount(client, id, v.name!, v.account);
      }
      await client.query('COMMIT');
      return { ...groomer, account_created: !existing && !!v.account, password_changed: !!v.newPassword };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 미용기록이나 예약이 있는 관리사는 삭제하지 않고 "퇴사"로 바꾸게 안내해요. 삭제하면 로그인 계정도 함께 지워져요. */
  @Roles(ROLE_ADMIN)
  @Delete(':id')
  async remove(@Param('id') idText: string) {
    const id = parseId(idText);
    await findGroomer(id);
    const [{ count }] = await query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM grooming_records WHERE groomer_id = $1',
      [id],
    );
    const [{ count: reservedCount }] = await query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM reservations WHERE groomer_id = $1',
      [id],
    );
    if (count > 0 || reservedCount > 0) {
      throw new ConflictException('미용기록이나 예약이 있는 관리사는 삭제할 수 없어요. 근무 상태를 "퇴사"로 바꿔 주세요.');
    }
    await query('DELETE FROM users WHERE groomer_id = $1', [id]);
    await query('DELETE FROM groomers WHERE id = $1', [id]);
    return { message: '삭제했어요.' };
  }
}
