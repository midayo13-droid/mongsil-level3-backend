import bcrypt from 'bcryptjs';
import { pool, query } from './db.js';
import { SLOTS, addDays, dayOfWeek, kstNow } from './time.js';

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS guardians (
  id SERIAL PRIMARY KEY,
  name VARCHAR(20) NOT NULL,
  phone VARCHAR(13) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL,
  emergency_name VARCHAR(20),
  emergency_phone VARCHAR(13),
  message VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dogs (
  id SERIAL PRIMARY KEY,
  guardian_id INTEGER NOT NULL REFERENCES guardians(id) ON DELETE RESTRICT,
  name VARCHAR(20) NOT NULL,
  breed VARCHAR(20) NOT NULL,
  gender VARCHAR(4) NOT NULL,
  age INTEGER NOT NULL,
  weight NUMERIC(4,1) NOT NULL,
  birthday DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dog_notes (
  id SERIAL PRIMARY KEY,
  dog_id INTEGER NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  content VARCHAR(300) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groomers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(20) NOT NULL,
  phone VARCHAR(13),
  status VARCHAR(4) NOT NULL DEFAULT '근무중',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grooming_records (
  id SERIAL PRIMARY KEY,
  dog_id INTEGER NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  groomer_id INTEGER NOT NULL REFERENCES groomers(id) ON DELETE RESTRICT,
  groomed_at DATE NOT NULL,
  style VARCHAR(20) NOT NULL,
  price INTEGER NOT NULL,
  memo VARCHAR(500),
  photo_data TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notices (
  id SERIAL PRIMARY KEY,
  title VARCHAR(50) NOT NULL,
  content VARCHAR(1000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  title VARCHAR(50) NOT NULL,
  content VARCHAR(1000) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dogs_guardian ON dogs(guardian_id);
CREATE INDEX IF NOT EXISTS idx_notes_dog ON dog_notes(dog_id);
CREATE INDEX IF NOT EXISTS idx_records_dog ON grooming_records(dog_id);
CREATE INDEX IF NOT EXISTS idx_records_date ON grooming_records(groomed_at);
`;


/** Level 3 에서 새로 더하는 테이블. Level 1 이 쓰는 테이블의 구조는 바꾸지 않아요. */
const CREATE_LEVEL3_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(20) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  name VARCHAR(20) NOT NULL,
  role VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 역할 이름 바꾸기: 관리자 → 총관리자, 일반 → 일반관리자 (고객 역할 추가). 이미 바뀌어 있으면 아무 일도 하지 않아요.
ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(10);
DROP INDEX IF EXISTS one_admin;
UPDATE users SET role = '총관리자' WHERE role = '관리자';
UPDATE users SET role = '일반관리자' WHERE role = '일반';
-- 사장님(총관리자) 계정은 하나뿐이에요.
CREATE UNIQUE INDEX IF NOT EXISTS one_master ON users ((role)) WHERE role = '총관리자';
-- 고객 계정은 보호자 한 명과 이어져요. (이 보호자의 강아지·예약만 볼 수 있어요)
ALTER TABLE users ADD COLUMN IF NOT EXISTS guardian_id INTEGER REFERENCES guardians(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_guardian ON users (guardian_id) WHERE guardian_id IS NOT NULL;
-- 관리사과 로그인 계정(일반관리자)은 같은 사람이라서 1:1 로 이어요.
ALTER TABLE users ADD COLUMN IF NOT EXISTS groomer_id INTEGER REFERENCES groomers(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_groomer ON users (groomer_id) WHERE groomer_id IS NOT NULL;

-- 공지사항 첨부파일 (공지가 지워지면 같이 지워져요)
CREATE TABLE IF NOT EXISTS notice_files (
  id SERIAL PRIMARY KEY,
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  mime VARCHAR(100) NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notice_files_notice ON notice_files(notice_id);
-- 이벤트 이미지·링크 (이벤트가 지워지면 같이 지워져요)
CREATE TABLE IF NOT EXISTS event_extras (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  link_url VARCHAR(500),
  image_name VARCHAR(200),
  image_type VARCHAR(100),
  image_data BYTEA
);

CREATE TABLE IF NOT EXISTS closed_days (
  id SERIAL PRIMARY KEY,
  closed_date DATE NOT NULL UNIQUE,
  name VARCHAR(30) NOT NULL,
  source VARCHAR(10) NOT NULL DEFAULT '직접'
);
ALTER TABLE closed_days ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT '직접';
-- 공휴일을 이미 불러온 해를 기억해요.
CREATE TABLE IF NOT EXISTS holiday_syncs (
  year INTEGER PRIMARY KEY,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  dog_id INTEGER NOT NULL REFERENCES dogs(id),
  groomer_id INTEGER NOT NULL REFERENCES groomers(id),
  reserved_date DATE NOT NULL,
  reserved_time VARCHAR(5) NOT NULL,
  style VARCHAR(20) NOT NULL,
  status VARCHAR(4) NOT NULL DEFAULT '신청',
  memo VARCHAR(300),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at TIMESTAMPTZ
);
-- 같은 관리사의 같은 시간, 같은 강아지의 같은 날에는 "신청" 예약을 하나만 둘 수 있어요. (서버 검사가 놓친 경우를 DB가 마지막으로 막아 줘요)
CREATE UNIQUE INDEX IF NOT EXISTS uq_res_groomer_slot ON reservations (groomer_id, reserved_date, reserved_time) WHERE status = '신청';
CREATE UNIQUE INDEX IF NOT EXISTS uq_res_dog_day ON reservations (dog_id, reserved_date) WHERE status = '신청';
CREATE INDEX IF NOT EXISTS idx_res_date ON reservations (reserved_date);
-- 예약이 있는 강아지·관리사는 지워지지 않게 막아요. 오류 번호가 23503(NO ACTION)이어야 Level 1 사이트도 "다른 정보와 연결되어 있어요"라고 쉬운 말로 안내해요.
-- (처음에 RESTRICT 로 만들어진 설정이 있으면 NO ACTION 으로 바꿔요.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_dog_id_fkey' AND confdeltype = 'r') THEN
    ALTER TABLE reservations DROP CONSTRAINT reservations_dog_id_fkey;
    ALTER TABLE reservations ADD CONSTRAINT reservations_dog_id_fkey FOREIGN KEY (dog_id) REFERENCES dogs(id);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_groomer_id_fkey' AND confdeltype = 'r') THEN
    ALTER TABLE reservations DROP CONSTRAINT reservations_groomer_id_fkey;
    ALTER TABLE reservations ADD CONSTRAINT reservations_groomer_id_fkey FOREIGN KEY (groomer_id) REFERENCES groomers(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dog_id INTEGER NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_user_day ON ai_requests (user_id, created_at);
`;

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 테이블이 없으면 만들고, 비어 있으면 가상 데이터를 채워 넣어요. (Level 1 과 같은 DB 를 함께 써요) */
export async function initDatabase() {
  await query(CREATE_TABLES);
  await query(CREATE_LEVEL3_TABLES);

  // Level 1 과 함께 쓰는 데이터: 비어 있을 때만 기본 가상 데이터를 넣어요. (이미 있으면 그대로 둬요)
  const [{ count }] = await query<{ count: string }>('SELECT COUNT(*) AS count FROM guardians');
  if (Number(count) === 0) {
    await seedDatabase();
  }

  const [{ count: userCount }] = await query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  if (Number(userCount) === 0) {
    await seedUsers();
    await seedClosedDays();
    await refillReservations();
  }
  const [{ count: closedCount }] = await query<{ count: string }>('SELECT COUNT(*) AS count FROM closed_days');
  if (Number(closedCount) === 0) {
    await seedClosedDays();
  }
  await seedCustomer();
  await linkSeedStaff();
}

/**
 * 확인용 관리사 계정(staff01)을 관리사 "강다은"과 이어요. (같은 사람을 한 번만 등록하는 구조)
 * 이미 이어져 있거나 이어 줄 관리사가 없으면 아무것도 하지 않아요.
 */
async function linkSeedStaff() {
  await query(
    `UPDATE users
        SET groomer_id = (SELECT g.id FROM groomers g WHERE g.name = '강다은' AND NOT EXISTS (SELECT 1 FROM users x WHERE x.groomer_id = g.id) ORDER BY g.id LIMIT 1),
            name = '강다은'
      WHERE username = 'staff01' AND groomer_id IS NULL
        AND EXISTS (SELECT 1 FROM groomers g WHERE g.name = '강다은' AND NOT EXISTS (SELECT 1 FROM users x WHERE x.groomer_id = g.id))`,
  );
}

/**
 * 확인용 가상 고객 계정(customer01)과 이 고객의 보호자·강아지를 만들어요. 이미 있으면 건드리지 않아요.
 * 실제 사람과 관련 없는 가상 정보예요.
 */
async function seedCustomer() {
  const exists = await query("SELECT id FROM users WHERE username = 'customer01'");
  if (exists.length > 0) return;

  let guardian = (await query<{ id: number }>("SELECT id FROM guardians WHERE phone = '010-5550-0999'"))[0];
  if (!guardian) {
    guardian = (
      await query<{ id: number }>(
        `INSERT INTO guardians (name, phone, email, emergency_name, emergency_phone, message)
         VALUES ('최고객', '010-5550-0999', 'customer01@example.com', '최가족', '010-5550-0998', '예약 문자는 오전에 보내 주세요.')
         RETURNING id`,
      )
    )[0];
    const dogRows = [
      ['새싹이', '푸들', '암컷', 3, 4.1, '2023-04-12'],
      ['누리', '말티즈', '수컷', 5, 3.6, null],
    ];
    const groomer = (await query<{ id: number }>("SELECT id FROM groomers WHERE status = '근무중' ORDER BY id LIMIT 1"))[0];
    for (const d of dogRows) {
      const dog = (
        await query<{ id: number }>(
          'INSERT INTO dogs (guardian_id, name, breed, gender, age, weight, birthday) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [guardian.id, ...d],
        )
      )[0];
      await query('INSERT INTO dog_notes (dog_id, content) VALUES ($1,$2)', [
        dog.id,
        d[0] === '새싹이' ? '발톱을 깎을 때 천천히 달래 주세요.' : '큰 소리를 무서워해요.',
      ]);
      if (groomer) {
        await query(
          "INSERT INTO grooming_records (dog_id, groomer_id, groomed_at, style, price, memo) VALUES ($1,$2,$3,$4,$5,$6)",
          [dog.id, groomer.id, daysAgo(21), d[0] === '새싹이' ? '가위컷' : '전체 클리핑', 45000, '지난번 스타일 유지'],
        );
      }
    }
  }
  await query('INSERT INTO users (username, password_hash, name, role, guardian_id) VALUES ($1,$2,$3,$4,$5)', [
    'customer01',
    await bcrypt.hash('Customer#2026', 10),
    '최고객',
    '고객',
    guardian.id,
  ]);
  console.log('확인용 가상 고객 계정(customer01)을 만들었어요.');
}

/** 확인용 가상 계정. 사장님(master) 1개, 관리사 1개 */
async function seedUsers() {
  const users = [
    ['master', 'Master#2026', '김하늘 사장님', '총관리자'],
    ['staff01', 'Staff#2026', '이직원', '일반관리자'],
  ];
  for (const [username, password, name, role] of users) {
    await query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4)', [
      username,
      await bcrypt.hash(password, 10),
      name,
      role,
    ]);
  }
  console.log('확인용 가상 계정(master, staff01)을 만들었어요.');
}

/** 확인용 휴무일. 실제 달력과 다를 수 있어서 사장님이 관리 화면에서 고칠 수 있어요. */
async function seedClosedDays() {
  const days = [
    ['2026-12-25', '성탄절'],
    ['2027-01-01', '신정'],
  ];
  for (const [date, name] of days) {
    await query('INSERT INTO closed_days (closed_date, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [date, name]);
  }
}

/**
 * 가상 예약 다시 채우기: 예약과 AI 사용 기록만 지우고, 앞으로 2주 안의 가상 예약을 넣어요.
 * 계정·휴무일, 그리고 Level 1 과 함께 쓰는 고객·강아지·기록 등은 지우지 않아요.
 */
export async function refillReservations() {
  const dogs = await query<{ id: number }>('SELECT id FROM dogs ORDER BY id');
  const groomers = await query<{ id: number }>("SELECT id FROM groomers WHERE status = '근무중' ORDER BY id");
  const closed = new Set((await query<{ closed_date: string }>('SELECT closed_date FROM closed_days')).map((r) => r.closed_date));
  const creator = await query<{ id: number }>("SELECT id FROM users WHERE role <> '고객' ORDER BY (role = '일반관리자') DESC, id LIMIT 1");

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ai_requests');
    await client.query('DELETE FROM reservations');
    if (dogs.length === 0 || groomers.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const isOpen = (date: string) => dayOfWeek(date) !== 0 && !closed.has(date);
    const nextOpen = (from: string) => {
      let d = from;
      while (!isOpen(d)) d = addDays(d, 1);
      return d;
    };
    const styles = ['가위컷', '전체 클리핑', '목욕만', '위생미용', '부분미용'];
    const memos = ['발톱 예민해요', '드라이기 무서워해요', null, '미용 후 사진 부탁드려요', null];
    const today = kstNow().date;

    const usedSlot = new Set<string>();
    const usedDogDay = new Set<string>();
    let created = 0;
    for (let i = 0; i < 16; i++) {
      // 처음 두 건은 오늘(쉬는 날이면 다음 영업일), 나머지는 앞으로 2주에 걸쳐 흩어 놔요.
      const date = nextOpen(i < 2 ? today : addDays(today, 1 + (i * 5) % 14));
      const groomer = groomers[i % groomers.length].id;
      const dog = dogs[(i * 3) % dogs.length].id;
      const time = SLOTS[(4 + i * 3) % SLOTS.length];
      const slotKey = `${groomer}|${date}|${time}`;
      const dogKey = `${dog}|${date}`;
      if (usedSlot.has(slotKey) || usedDogDay.has(dogKey)) continue;
      usedSlot.add(slotKey);
      usedDogDay.add(dogKey);
      const canceled = i % 7 === 6; // 일부는 취소된 예약으로
      await client.query(
        `INSERT INTO reservations (dog_id, groomer_id, reserved_date, reserved_time, style, status, memo, created_by, canceled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          dog,
          groomer,
          date,
          time,
          styles[i % styles.length],
          canceled ? '취소' : '신청',
          memos[i % memos.length],
          creator[0]?.id ?? null,
          canceled ? new Date() : null,
        ],
      );
      created++;
    }
    await client.query('COMMIT');
    return created;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 모두 가상의 이름·번호예요. 실제 사람과 관련이 없어요. */
async function seedDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const guardians = [
      ['김가은', '010-5550-0101', 'gaeun.kim@example.com', '김도현', '010-5550-0201', '발톱 깎을 때 천천히 부탁드려요.'],
      ['이준호', '010-5550-0102', 'junho.lee@example.com', null, null, null],
      ['박서연', '010-5550-0103', 'seoyeon.park@example.com', '박민준', '010-5550-0203', '미용 후 사진 보내 주세요.'],
      ['최민재', '010-5550-0104', 'minjae.choi@example.com', null, null, null],
      ['정유나', '010-5550-0105', 'yuna.jung@example.com', '정하준', '010-5550-0205', null],
      ['한지우', '010-5550-0106', 'jiwoo.han@example.com', null, null, '예약 전에 문자 주세요.'],
      ['오세린', '010-5550-0107', 'serin.oh@example.com', '오지훈', '010-5550-0207', null],
      ['윤태오', '010-5550-0108', 'taeo.yoon@example.com', null, null, null],
    ];
    const gIds: number[] = [];
    for (const g of guardians) {
      const r = await client.query(
        `INSERT INTO guardians (name, phone, email, emergency_name, emergency_phone, message)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        g,
      );
      gIds.push(r.rows[0].id);
    }

    // [보호자 순번, 이름, 견종, 성별, 나이, 몸무게, 생일]
    const dogs: [number, string, string, string, number, number, string | null][] = [
      [0, '몽실이', '말티즈', '암컷', 4, 3.5, '2022-03-14'],
      [0, '보리', '푸들', '수컷', 2, 4.2, '2024-06-02'],
      [1, '초코', '푸들', '수컷', 6, 5.8, '2020-11-21'],
      [2, '구름이', '비숑', '암컷', 3, 6.1, '2023-04-09'],
      [2, '두부', '포메라니안', '수컷', 5, 2.9, null],
      [2, '별이', '시츄', '암컷', 8, 7.4, '2018-08-30'],
      [3, '콩이', '치와와', '암컷', 1, 2.1, '2025-02-17'],
      [4, '밤톨이', '웰시코기', '수컷', 4, 11.5, '2022-09-05'],
      [5, '루비', '골든리트리버', '암컷', 3, 27.3, '2023-01-26'],
      [6, '하루', '믹스견', '수컷', 7, 8.8, null],
      [6, '달이', '말티즈', '암컷', 2, 3.2, '2024-10-11'],
      [7, '쿠키', '푸들', '암컷', 5, 4.9, '2021-05-19'],
    ];
    const dIds: number[] = [];
    for (const d of dogs) {
      const r = await client.query(
        `INSERT INTO dogs (guardian_id, name, breed, gender, age, weight, birthday)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [gIds[d[0]], d[1], d[2], d[3], d[4], d[5], d[6]],
      );
      dIds.push(r.rows[0].id);
    }

    const groomers = [
      ['강다은', '010-5550-0301', '근무중'],
      ['송민기', '010-5550-0302', '근무중'],
      ['임수빈', '010-5550-0303', '근무중'],
      ['배진우', '010-5550-0304', '퇴사'],
    ];
    const grIds: number[] = [];
    for (const g of groomers) {
      const r = await client.query(
        'INSERT INTO groomers (name, phone, status) VALUES ($1,$2,$3) RETURNING id',
        g,
      );
      grIds.push(r.rows[0].id);
    }

    // [강아지 순번, 내용, 며칠 전]
    const notes: [number, string, number][] = [
      [0, '발톱 깎을 때 예민해요. 천천히 달래 주세요.', 120],
      [0, '귀 청소는 싫어해서 짧게 해 주세요.', 30],
      [2, '드라이기 소리를 무서워해요.', 90],
      [3, '얼굴 주변을 만지면 으르렁거려요. 조심!', 60],
      [3, '미용 후 간식(닭가슴살) 주면 좋아해요.', 14],
      [5, '관절이 약해서 오래 세워 두지 않기.', 45],
      [8, '털이 많이 빠져요. 목욕 시간을 넉넉히.', 20],
      [9, '다른 강아지와 같이 두면 흥분해요.', 10],
    ];
    for (const n of notes) {
      await client.query(
        `INSERT INTO dog_notes (dog_id, content, created_at)
         VALUES ($1,$2, now() - ($3 || ' days')::interval)`,
        [dIds[n[0]], n[1], String(n[2])],
      );
    }

    // [강아지 순번, 관리사 순번, 며칠 전, 스타일, 가격, 메모]
    const records: [number, number, number, string, number, string | null][] = [
      [0, 0, 2, '가위컷', 45000, '귀 주변 둥글게 잘랐어요.'],
      [1, 0, 2, '전체 클리핑', 40000, null],
      [2, 1, 3, '목욕만', 25000, '피부 상태 양호.'],
      [3, 2, 5, '가위컷', 55000, '얼굴 라인은 짧게.'],
      [4, 2, 5, '위생미용', 20000, null],
      [5, 1, 7, '목욕만', 30000, '관절 때문에 짧게 진행.'],
      [6, 0, 8, '부분미용', 18000, '첫 방문이었어요.'],
      [7, 1, 10, '전체 클리핑', 50000, null],
      [8, 2, 12, '목욕만', 60000, '털 빠짐 많음.'],
      [9, 0, 14, '위생미용', 22000, null],
      [10, 0, 14, '가위컷', 42000, '리본 달아 드렸어요.'],
      [11, 1, 18, '전체 클리핑', 40000, null],
      [0, 0, 32, '가위컷', 45000, '지난번과 같은 스타일.'],
      [1, 2, 35, '목욕만', 25000, null],
      [2, 1, 40, '전체 클리핑', 45000, null],
      [3, 2, 44, '가위컷', 55000, null],
      [5, 1, 50, '위생미용', 22000, null],
      [7, 3, 55, '전체 클리핑', 50000, null],
      [8, 2, 62, '목욕만', 60000, null],
      [9, 0, 70, '부분미용', 18000, null],
      [4, 2, 75, '위생미용', 20000, null],
      [11, 3, 80, '가위컷', 48000, '구름 모양으로 다듬었어요.'],
      [6, 0, 90, '목욕만', 20000, null],
      [10, 1, 100, '전체 클리핑', 38000, null],
      [0, 3, 120, '가위컷', 45000, null],
    ];
    for (const r of records) {
      await client.query(
        `INSERT INTO grooming_records (dog_id, groomer_id, groomed_at, style, price, memo)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [dIds[r[0]], grIds[r[1]], daysAgo(r[2]), r[3], r[4], r[5]],
      );
    }

    const notices = [
      ['추석 연휴 영업 안내', '연휴 기간에는 오전 10시부터 오후 3시까지만 운영해요. 예약은 미리 전화 주세요.', 20],
      ['여름철 털 관리 안내', '더운 날씨에는 짧은 미용을 추천드려요. 상담은 언제든 환영이에요.', 8],
      ['주차 안내', '매장 앞 주차 공간이 좁아요. 건물 뒤편 주차장을 이용해 주세요.', 2],
    ];
    for (const n of notices) {
      await client.query(
        `INSERT INTO notices (title, content, created_at)
         VALUES ($1,$2, now() - ($3 || ' days')::interval)`,
        [n[0], n[1], String(n[2])],
      );
    }

    // [제목, 내용, 시작일(며칠 전), 종료일(며칠 전, 음수면 앞으로)]
    const events = [
      ['첫 방문 10% 할인', '처음 오시는 강아지는 미용 요금을 10% 깎아 드려요.', 10, -40],
      ['생일 강아지 리본 선물', '생일이 있는 달에는 예쁜 리본을 무료로 달아 드려요.', 5, -25],
      ['친구 소개 이벤트', '친구를 소개해 주시면 다음 목욕이 1회 무료예요.', -3, -60],
    ];
    for (const e of events) {
      await client.query(
        'INSERT INTO events (title, content, start_date, end_date) VALUES ($1,$2,$3,$4)',
        [e[0], e[1], daysAgo(e[2] as number), daysAgo(e[3] as number)],
      );
    }

    await client.query('COMMIT');
    console.log('가상 데이터를 채워 넣었어요.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 무료 공휴일 API(Nager.Date, 키 필요 없음)에서 그 해의 대한민국 공휴일을 불러와 휴무일에 넣어요.
 * 이미 있는 날짜는 그대로 두고, 불러오지 못하면 조용히 넘어가요(직접 등록한 휴무일은 계속 쓸 수 있어요).
 * force 가 아니면 이미 불러온 해는 다시 부르지 않아요.
 */
export async function syncHolidays(year: number, force = false): Promise<{ added: number; ok: boolean }> {
  if (!force) {
    const done = await query('SELECT year FROM holiday_syncs WHERE year = $1', [year]);
    if (done.length > 0) return { added: 0, ok: true };
  }
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = (await res.json()) as Array<{ date: string; localName: string }>;
    if (!Array.isArray(list) || list.length === 0) throw new Error('공휴일 목록이 비어 있어요');
    let added = 0;
    for (const h of list) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) continue;
      const r = await query(
        "INSERT INTO closed_days (closed_date, name, source) VALUES ($1,$2,'공휴일') ON CONFLICT (closed_date) DO NOTHING RETURNING id",
        [h.date, String(h.localName).slice(0, 30)],
      );
      added += r.length;
    }
    await query('INSERT INTO holiday_syncs (year) VALUES ($1) ON CONFLICT (year) DO UPDATE SET synced_at = now()', [year]);
    return { added, ok: true };
  } catch (error) {
    console.error('공휴일을 불러오지 못했어요:', (error as Error).message);
    return { added: 0, ok: false };
  }
}
