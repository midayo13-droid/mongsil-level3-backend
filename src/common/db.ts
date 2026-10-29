import 'dotenv/config';
import pg from 'pg';

// 날짜(DATE)는 시간대 계산 없이 "2026-10-26" 같은 글자 그대로 받아요.
pg.types.setTypeParser(1082, (value: string) => value);

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL 이 .env 에 없어요. .env.example 을 참고해 주세요.');
}

// Render 의 PostgreSQL 은 암호화 접속(SSL)이 필요해요. 내 컴퓨터(localhost) DB 는 필요 없어요.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);

export const pool = new pg.Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
