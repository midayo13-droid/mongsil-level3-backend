import type { AuthUser } from '../auth/auth.js';
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { pool, query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { Checker, parseId } from '../common/validation.js';
import { assertPhoneFree, validateDog, validateGuardian } from '../guardians/guardians.logic.js';
import { ALL_ROLES, CurrentUser, Public, ROLE_ADMIN, ROLE_CUSTOMER, ROLE_STAFF, Roles, signToken } from './auth.js';

// 없는 아이디로 로그인해도 걸리는 시간이 비슷하도록 쓰는 가짜 해시
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

@Controller()
export class AuthController {
  @Public()
  @Post('auth/login')
  async login(@Body() body: any) {
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: {
          ...(username ? {} : { username: '아이디를 적어 주세요.' }),
          ...(password ? {} : { password: '비밀번호를 적어 주세요.' }),
        },
      });
    }
    const row = await queryOne<AuthUser & { password_hash: string; groomer_status: string | null }>(
      `SELECT u.id, u.username, u.name, u.role, u.guardian_id, u.groomer_id, u.password_hash, g.status AS groomer_status
         FROM users u LEFT JOIN groomers g ON g.id = u.groomer_id WHERE u.username = $1`,
      [username],
    );
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      // 어느 쪽이 틀렸는지는 알려 주지 않아요.
      throw new UnauthorizedException('아이디나 비밀번호를 다시 확인해 주세요.');
    }
    // 비밀번호까지 맞았을 때만 알려 줘요: 퇴사 처리된 관리사는 로그인할 수 없어요.
    if (row.groomer_status === '퇴사') {
      throw new UnauthorizedException('퇴사 처리된 계정이에요. 사장님께 문의해 주세요.');
    }
    const user: AuthUser = { id: row.id, username: row.username, name: row.name, role: row.role, guardian_id: row.guardian_id, groomer_id: row.groomer_id };
    return { token: signToken(user), user };
  }

  /**
   * 고객 가입: 계정 + 보호자 + 강아지(1~5마리)를 한꺼번에 저장해요. 하나라도 실패하면 아무것도 저장하지 않아요. (S-6)
   * 이미 등록된 휴대폰 번호면 가입할 수 없어요. (S-2) 없는 번호는 새 보호자로 만들어요. (S-3)
   */
  @Public()
  @Post('auth/signup')
  async signup(@Body() body: any) {
    const c = new Checker();
    const acc = new Checker();
    const account = body?.account ?? {};
    const username = acc.text(account, 'username', '아이디', { required: true, min: 4, max: 20 });
    if (username && !/^[A-Za-z0-9]+$/.test(username)) acc.fail('username', '아이디는 영문과 숫자만 쓸 수 있어요.');
    const password = typeof account?.password === 'string' ? account.password : '';
    if (!password) acc.fail('password', '비밀번호를 꼭 적어 주세요.');
    else if (password.length < 8) acc.fail('password', '비밀번호는 8자 이상으로 적어 주세요.');
    else if (password.length > 50) acc.fail('password', '비밀번호는 50자 이내로 적어 주세요.');
    c.merge(acc, 'account.');

    const g = validateGuardian(body?.guardian ?? {});
    c.merge(g.c, 'guardian.');

    const dogBodies: any[] = Array.isArray(body?.dogs) ? body.dogs : [];
    if (dogBodies.length === 0) c.fail('dogs', '강아지를 한 마리 이상 등록해 주세요.');
    else if (dogBodies.length > 5) c.fail('dogs', '가입할 때는 강아지를 5마리까지 등록할 수 있어요.');
    const dogs = dogBodies.slice(0, 5).map((dogBody, index) => {
      const d = validateDog(dogBody);
      c.merge(d.c, `dogs.${index}.`);
      return d.value;
    });
    c.done();

    const taken = await queryOne('SELECT id FROM users WHERE username = $1', [username]);
    if (taken) {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: { 'account.username': '이미 쓰고 있는 아이디예요. 다른 아이디를 적어 주세요.' },
      });
    }
    // S-2: 같은 번호의 보호자가 이미 있으면 가입할 수 없어요.
    try {
      await assertPhoneFree(g.value.phone!);
    } catch {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: { 'guardian.phone': '이미 등록된 번호예요. 매장에 문의해 주세요.' },
      });
    }

    const hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const gv = g.value;
      const guardian = (
        await client.query(
          `INSERT INTO guardians (name, phone, email, emergency_name, emergency_phone, message)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [gv.name, gv.phone, gv.email, gv.emergency_name, gv.emergency_phone, gv.message],
        )
      ).rows[0];
      for (const d of dogs) {
        await client.query(
          `INSERT INTO dogs (guardian_id, name, breed, gender, age, weight, birthday) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [guardian.id, d.name, d.breed, d.gender, d.age, d.weight, d.birthday],
        );
      }
      const created = (
        await client.query(
          'INSERT INTO users (username, password_hash, name, role, guardian_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [username, hash, gv.name, ROLE_CUSTOMER, guardian.id],
        )
      ).rows[0];
      await client.query('COMMIT');
      const user: AuthUser = { id: created.id, username: username!, name: gv.name!, role: ROLE_CUSTOMER, guardian_id: guardian.id, groomer_id: null };
      return { token: signToken(user), user };
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') {
        const field = String(error.constraint ?? '').includes('username') ? 'account.username' : 'guardian.phone';
        throw new BadRequestException({
          message: '입력한 내용을 다시 확인해 주세요.',
          errors: {
            [field]: field === 'guardian.phone' ? '이미 등록된 번호예요. 매장에 문의해 주세요.' : '이미 쓰고 있는 아이디예요. 다른 아이디를 적어 주세요.',
          },
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  @Roles(...ALL_ROLES)
  @Get('auth/me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /* ---------- 계정 목록 (사장님만) ---------- */

  /**
   * 계정 목록. 관리사(일반관리자) 계정은 "관리사" 화면에서 관리사와 함께 만들고 지워요.
   * 고객 계정은 고객이 가입으로 만들고, 사장님은 여기서 보거나 지울 수 있어요.
   */
  @Roles(ROLE_ADMIN)
  @Get('users')
  list(@Query('role') role?: string, @Query('page') page?: string, @Query('size') size?: string) {
    return listOrAll(
      parsePaging(page, size),
      `SELECT u.id, u.username, u.name, u.role, u.created_at, g.phone AS guardian_phone, gr.name AS groomer_name
         FROM users u
         LEFT JOIN guardians g ON g.id = u.guardian_id
         LEFT JOIN groomers gr ON gr.id = u.groomer_id
        WHERE ($1::text IS NULL OR u.role = $1)
        ORDER BY CASE u.role WHEN '총관리자' THEN 0 WHEN '일반관리자' THEN 1 ELSE 2 END, u.id`,
      [['총관리자', '일반관리자', '고객'].includes(role ?? '') ? role : null],
    );
  }

  /** 고객 상세 화면용: 계정 + 보호자 정보 + 강아지 + 예약 (사장님 전용) */
  @Roles(ROLE_ADMIN)
  @Get('users/:id')
  async detail(@Param('id') idText: string) {
    const id = parseId(idText);
    const user = await queryOne<any>('SELECT id, username, name, role, guardian_id, created_at FROM users WHERE id = $1', [id]);
    if (!user) throw new NotFoundException('계정을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    if (user.role !== ROLE_CUSTOMER) {
      throw new ConflictException('고객 계정만 이 화면에서 볼 수 있어요. 관리사 계정은 "관리사 관리" 화면에서 확인해요.');
    }
    const guardian = user.guardian_id ? await queryOne('SELECT * FROM guardians WHERE id = $1', [user.guardian_id]) : null;
    const dogs = user.guardian_id
      ? await query('SELECT id, name, breed, gender, age FROM dogs WHERE guardian_id = $1 ORDER BY id', [user.guardian_id])
      : [];
    const reservations = user.guardian_id
      ? await query(
          `SELECT r.id, r.reserved_date, r.reserved_time, r.style, r.status, d.name AS dog_name
             FROM reservations r JOIN dogs d ON d.id = r.dog_id
            WHERE d.guardian_id = $1
            ORDER BY r.reserved_date DESC, r.reserved_time DESC, r.id DESC LIMIT 5`,
          [user.guardian_id],
        )
      : [];
    const counts = user.guardian_id
      ? await queryOne<any>(
          `SELECT COUNT(*) FILTER (WHERE r.status = '신청' AND r.reserved_date >= CURRENT_DATE)::int AS upcoming_count,
                  COUNT(*)::int AS total_count
             FROM reservations r JOIN dogs d ON d.id = r.dog_id WHERE d.guardian_id = $1`,
          [user.guardian_id],
        )
      : { upcoming_count: 0, total_count: 0 };
    return { user, guardian, dogs, reservations, ...counts };
  }

  /** 지울 수 있는 계정은 고객 계정뿐이에요. 총관리자는 지울 수 없고, 관리사 계정은 관리사과 함께 관리해요. */
  @Roles(ROLE_ADMIN)
  @Delete('users/:id')
  async remove(@Param('id') idText: string, @CurrentUser() me: AuthUser) {
    const id = parseId(idText);
    const target = await queryOne<{ id: number; role: string; name: string }>(
      'SELECT id, role, name FROM users WHERE id = $1',
      [id],
    );
    if (!target) throw new NotFoundException('계정을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    if (target.role === ROLE_ADMIN || target.id === me.id) {
      throw new ConflictException('사장님(master) 계정은 지울 수 없어요.');
    }
    if (target.role === ROLE_STAFF) {
      throw new ConflictException('관리사 계정은 "관리사" 화면에서 관리사와 함께 관리해요. 퇴사 처리하면 로그인할 수 없어요.');
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    return { message: '삭제했어요.' };
  }
}
