/** 예약은 모두 한국 시간(KST) 기준이에요. 날짜는 "2026-10-26", 시간은 "14:30" 글자로 다뤄요. */

/** 예약 가능한 시간: 10:00 ~ 17:30, 30분 단위 */
export const SLOTS: string[] = (() => {
  const list: string[] = [];
  for (let h = 10; h < 18; h++) {
    list.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`);
  }
  return list;
})();

export const MAX_PER_GROOMER_PER_DAY = 6;

/** 지금 한국 시간 */
export function kstNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** 날짜에 일수를 더해요. 예: addDays("2026-10-30", -1) → "2026-10-29" */
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = 일요일 */
export function dayOfWeek(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isValidDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

/** 이번 달 1일 ~ 다음 달 1일 (한국 시간 기준) */
export function monthRange() {
  const { date } = kstNow();
  const first = `${date.slice(0, 7)}-01`;
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return { from: first, to: d.toISOString().slice(0, 10) };
}
