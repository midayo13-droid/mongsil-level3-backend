import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { queryOne } from '../common/db.js';

/** 역할: 총관리자(사장님, 1명) / 일반관리자(관리사) / 고객 */
export const ROLE_ADMIN = '총관리자';
export const ROLE_STAFF = '일반관리자';
export const ROLE_CUSTOMER = '고객';
export const ALL_ROLES = [ROLE_ADMIN, ROLE_STAFF, ROLE_CUSTOMER];
/** 관리자 화면을 쓰는 역할 */
export const STAFF_ROLES = [ROLE_ADMIN, ROLE_STAFF];

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role: string;
  /** 고객 계정만: 연결된 보호자 번호. 이 보호자의 강아지·예약만 볼 수 있어요. */
  guardian_id: number | null;
  /** 관리사(일반관리자) 계정만: 연결된 관리사 번호 */
  groomer_id: number | null;
}

const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('JWT_SECRET 이 .env 에 없어요. .env.example 을 참고해 주세요.');
}
const TOKEN_HOURS = 8;

export function signToken(user: Pick<AuthUser, 'id'>) {
  return jwt.sign({ uid: user.id }, secret as string, { expiresIn: `${TOKEN_HOURS}h` });
}

/** 로그인 없이 쓸 수 있는 주소 (로그인, 가입, /health) */
export const Public = () => SetMetadata('isPublic', true);

/**
 * 이 역할만 쓸 수 있는 주소. 예: @Roles(ROLE_ADMIN)
 * 아무것도 적지 않은 주소는 "관리자 화면 역할(총관리자·일반관리자)"만 쓸 수 있어요.
 * (고객이 실수로 관리자용 주소를 열지 못하게, 기본값은 막는 쪽이에요.)
 */
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

/** 요청한 사람의 정보 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});

/** 모든 주소에서 로그인(출입증)과 역할을 서버가 한 번 더 확인해요. */
@Injectable()
export class AuthGuard implements CanActivate {
  private reflector = new Reflector();

  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('isPublic', targets)) return true;

    const request = context.switchToHttp().getRequest();
    const header: string = request.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('로그인이 필요해요. 로그인해 주세요.');

    let uid: number;
    try {
      const payload = jwt.verify(token, secret as string) as { uid?: number };
      uid = Number(payload.uid);
    } catch {
      throw new UnauthorizedException('로그인 시간이 끝났어요. 다시 로그인해 주세요.');
    }

    // 계정이 지워졌으면 출입증이 남아 있어도 쓸 수 없어요.
    const user = await queryOne<AuthUser & { groomer_status: string | null }>(
      `SELECT u.id, u.username, u.name, u.role, u.guardian_id, u.groomer_id, g.status AS groomer_status
         FROM users u LEFT JOIN groomers g ON g.id = u.groomer_id WHERE u.id = $1`,
      [uid],
    );
    if (!user) throw new UnauthorizedException('로그인 정보를 찾을 수 없어요. 다시 로그인해 주세요.');
    // 퇴사 처리된 관리사의 계정은 출입증이 남아 있어도 쓸 수 없어요.
    if (user.groomer_status === '퇴사') {
      throw new UnauthorizedException('퇴사 처리된 계정이에요. 사장님께 문의해 주세요.');
    }
    request.user = user;

    const declared = this.reflector.getAllAndOverride<string[]>('roles', targets);
    const allowed = declared && declared.length > 0 ? declared : STAFF_ROLES;
    if (!allowed.includes(user.role)) {
      throw new ForbiddenException(
        user.role === ROLE_CUSTOMER ? '내 정보만 볼 수 있어요.' : '이 일은 사장님만 할 수 있어요.',
      );
    }
    return true;
  }
}
