import { query } from './db.js';

/** 페이지 나누기 요청 값. page 가 없으면 null (전체를 한꺼번에 돌려줘요: 선택 상자 등에서 써요). */
export interface Paging {
  page: number;
  size: number;
}

export function parsePaging(page?: string, size?: string, defaultSize = 20): Paging | null {
  const p = Number.parseInt(page ?? '', 10);
  if (!Number.isFinite(p) || p < 1) return null;
  const s = Number.parseInt(size ?? '', 10);
  return { page: p, size: Number.isFinite(s) && s >= 1 ? Math.min(s, 100) : defaultSize };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/**
 * 목록 조회. paging 이 있으면 { items, total, page, size } 로, 없으면 전체 배열로 돌려줘요.
 * sql 은 마지막이 ORDER BY 인 SELECT 문이어야 해요. 마지막 쪽보다 큰 쪽 번호는 마지막 쪽으로 맞춰 줘요.
 */
export async function listOrAll<T = any>(paging: Paging | null, sql: string, params: any[] = []): Promise<T[] | Paged<T>> {
  if (!paging) return query<T>(sql, params);
  const totalRow = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM (${sql}) AS t`, params);
  const total = totalRow[0]?.n ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / paging.size));
  const page = Math.min(paging.page, lastPage);
  const items = await query<T>(`${sql} LIMIT ${paging.size} OFFSET ${(page - 1) * paging.size}`, params);
  return { items, total, page, size: paging.size };
}
