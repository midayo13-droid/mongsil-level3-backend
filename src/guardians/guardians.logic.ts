import { BadRequestException, NotFoundException } from '@nestjs/common';
import { query, queryOne } from '../common/db.js';
import { BREEDS, Checker, GENDERS } from '../common/validation.js';

/** 보호자 입력 검사. 규칙은 모두 여기(백엔드)에서 지켜요. */
export function validateGuardian(body: any) {
  const c = new Checker();
  const value = {
    name: c.text(body, 'name', '이름', { required: true, min: 2, max: 20 }),
    phone: c.phone(body, 'phone', '휴대폰 번호', true),
    email: c.email(body, 'email', '이메일', true),
    emergency_name: c.text(body, 'emergency_name', '비상연락처 이름', { max: 20 }),
    emergency_phone: c.phone(body, 'emergency_phone', '비상연락처 번호', false),
    message: c.text(body, 'message', '하고 싶은 말', { max: 500 }),
  };
  return { c, value };
}

/** 강아지 입력 검사 (보호자 번호는 따로 다뤄요). */
export function validateDog(body: any) {
  const c = new Checker();
  const value = {
    name: c.text(body, 'name', '강아지 이름', { required: true, max: 20 }),
    breed: c.choice(body, 'breed', '견종', BREEDS, true),
    gender: c.choice(body, 'gender', '성별', GENDERS, true),
    age: c.number(body, 'age', '나이', { required: true, min: 0, max: 30, integer: true, unit: '살' }),
    weight: c.number(body, 'weight', '몸무게', { required: true, min: 0.1, max: 100, unit: 'kg' }),
    birthday: c.date(body, 'birthday', '생일', { notFuture: true }),
  };
  if (value.weight !== null && Math.abs(value.weight * 10 - Math.round(value.weight * 10)) > 1e-9) {
    c.fail('weight', '몸무게는 소수점 한 자리까지만 적을 수 있어요. 예: 4.5');
  }
  return { c, value };
}

/** 같은 번호의 보호자가 이미 있으면 막아요. (수정할 때는 자기 자신은 제외) */
export async function assertPhoneFree(phone: string, exceptId?: number) {
  const found = await queryOne<{ id: number }>(
    'SELECT id FROM guardians WHERE phone = $1 AND ($2::int IS NULL OR id <> $2)',
    [phone, exceptId ?? null],
  );
  if (found) {
    throw new BadRequestException({
      message: '입력한 내용을 다시 확인해 주세요.',
      errors: { phone: '이미 등록된 번호예요. 고객 목록에서 찾아 주세요.' },
    });
  }
}

export async function findGuardian(id: number) {
  const guardian = await queryOne('SELECT * FROM guardians WHERE id = $1', [id]);
  if (!guardian) throw new NotFoundException('고객 정보를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
  return guardian;
}

export async function findDogs(guardianId: number) {
  return query(
    `SELECT d.id, d.name, d.breed, d.gender, d.age, d.weight::float AS weight, d.birthday
       FROM dogs d WHERE d.guardian_id = $1 ORDER BY d.id`,
    [guardianId],
  );
}
