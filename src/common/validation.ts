import { BadRequestException } from '@nestjs/common';

export const BREEDS = [
  '말티즈', '푸들', '포메라니안', '시츄', '비숑', '치와와',
  '웰시코기', '골든리트리버', '믹스견', '기타',
];
export const GENDERS = ['수컷', '암컷'];
export const STYLES = ['전체 클리핑', '가위컷', '목욕만', '위생미용', '부분미용', '기타'];
export const GROOMER_STATUSES = ['근무중', '퇴사'];

/** 칸 이름별 안내 문구를 모아서 한 번에 돌려줘요. */
export class Checker {
  errors: Record<string, string> = {};

  fail(field: string, message: string) {
    if (!this.errors[field]) this.errors[field] = message;
  }

  /** 다른 검사기의 오류를 앞이름(prefix)을 붙여 합쳐요. */
  merge(other: Checker, prefix: string) {
    for (const [field, message] of Object.entries(other.errors)) {
      this.fail(`${prefix}${field}`, message);
    }
  }

  /** 글 칸: 필수/길이 검사 후 다듬은 글을 돌려줘요. */
  text(body: any, field: string, label: string, opts: { required?: boolean; min?: number; max: number }) {
    const raw = body?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (opts.required) this.fail(field, `${josa(label, "을")} 꼭 적어 주세요.`);
      return null;
    }
    if (value.length < (opts.min ?? 1)) {
      this.fail(field, `${josa(label, "은")} ${opts.min}자 이상 적어 주세요.`);
    }
    if (value.length > opts.max) {
      this.fail(field, `${josa(label, "은")} ${opts.max}자 이내로 적어 주세요.`);
    }
    return value;
  }

  /** 전화번호: 숫자 11자리(010 시작). 하이픈이 있어도 괜찮아요. */
  phone(body: any, field: string, label: string, required: boolean) {
    const raw = body?.[field];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value) {
      if (required) this.fail(field, `${josa(label, "을")} 꼭 적어 주세요.`);
      return null;
    }
    if (!/^[0-9\-\s]+$/.test(value)) {
      this.fail(field, `${label}에는 숫자만 적을 수 있어요. 예: 010-1234-5678`);
      return null;
    }
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 11 || !digits.startsWith('010')) {
      this.fail(field, `${label}는 숫자 11자리로 적어 주세요. 예: 010-1234-5678`);
      return null;
    }
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }

  email(body: any, field: string, label: string, required: boolean) {
    const value = this.text(body, field, label, { required, max: 100 });
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      this.fail(field, `${label} 주소를 다시 확인해 주세요. 예: abc@email.com`);
      return null;
    }
    return value;
  }

  /** 숫자 칸: 글자가 섞이면 안내해요. */
  number(
    body: any,
    field: string,
    label: string,
    opts: { required?: boolean; min: number; max: number; integer?: boolean; unit?: string },
  ) {
    const raw = body?.[field];
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!text) {
      if (opts.required) this.fail(field, `${josa(label, "을")} 꼭 적어 주세요.`);
      return null;
    }
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      this.fail(field, `${label}에는 숫자만 적을 수 있어요.`);
      return null;
    }
    const n = Number(text);
    const unit = opts.unit ?? '';
    if (opts.integer && !Number.isInteger(n)) {
      this.fail(field, `${josa(label, "은")} 소수점 없이 정수로 적어 주세요.`);
      return null;
    }
    if (n < opts.min || n > opts.max) {
      this.fail(field, `${josa(label, "은")} ${opts.min}${unit}~${opts.max}${unit} 사이로 적어 주세요.`);
      return null;
    }
    return n;
  }

  /** 정해진 목록에서 고르는 칸 */
  choice(body: any, field: string, label: string, list: string[], required: boolean) {
    const raw = body?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (required) this.fail(field, `${josa(label, "을")} 골라 주세요.`);
      return null;
    }
    if (!list.includes(value)) {
      this.fail(field, `${josa(label, "은")} 목록에서 골라 주세요.`);
      return null;
    }
    return value;
  }

  date(body: any, field: string, label: string, opts: { required?: boolean; notFuture?: boolean }) {
    const raw = body?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (opts.required) this.fail(field, `${josa(label, "을")} 골라 주세요.`);
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      this.fail(field, `${josa(label, "은")} 날짜로 골라 주세요.`);
      return null;
    }
    if (opts.notFuture && value > todayString()) {
      this.fail(field, `${josa(label, "은")} 오늘 이후 날짜를 고를 수 없어요.`);
      return null;
    }
    return value;
  }

  /** 번호(id) 값 */
  id(body: any, field: string, label: string, required = true) {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, `${josa(label, "을")} 골라 주세요.`);
      return null;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      this.fail(field, `${josa(label, "을")} 다시 골라 주세요.`);
      return null;
    }
    return n;
  }

  /** 사진: 데이터 주소(data URL) 형태, jpg/png, 5MB 이하 */
  photo(body: any, field: string) {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
      this.fail(field, '사진 파일을 다시 올려 주세요.');
      return null;
    }
    const match = /^data:(image\/(jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!match) {
      this.fail(field, '사진은 5MB 이하의 jpg, png 파일만 올릴 수 있어요.');
      return null;
    }
    const bytes = Math.floor((match[3].length * 3) / 4);
    if (bytes > 5 * 1024 * 1024) {
      this.fail(field, '사진은 5MB 이하의 jpg, png 파일만 올릴 수 있어요.');
      return null;
    }
    return raw;
  }

  /** 올린 파일(data URL 글자)을 검사하고 내용(Buffer)으로 바꿔요. */
  file(body: any, kinds: Record<string, string>, label: string, maxMb = 5) {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : '';
    const raw = typeof body?.data === 'string' ? body.data : '';
    const match = /^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? '';
    if (!name || !match) {
      this.fail('file', `${label} 파일을 다시 골라 주세요.`);
      return null;
    }
    if (!kinds[ext]) {
      this.fail('file', `${label}은 ${Object.keys(kinds).join(', ')} 파일만 올릴 수 있어요.`);
      return null;
    }
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length === 0 || buffer.length > maxMb * 1024 * 1024) {
      this.fail('file', `${label}은 ${maxMb}MB 이하 파일만 올릴 수 있어요.`);
      return null;
    }
    return { name, mime: kinds[ext], buffer };
  }

  /** 링크 칸: 비워도 되고, 적으면 http:// 또는 https:// 로 시작해야 해요. */
  url(body: any, field: string, label: string) {
    const raw = body?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return null;
    let ok = value.length <= 500 && /^https?:\/\/\S+$/i.test(value);
    if (ok) {
      try {
        new URL(value);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      this.fail(field, `${label}는 http:// 또는 https:// 로 시작하는 주소를 500자 이내로 적어 주세요.`);
      return null;
    }
    return value;
  }

  done() {
    const keys = Object.keys(this.errors);
    if (keys.length > 0) {
      throw new BadRequestException({
        message: '입력한 내용을 다시 확인해 주세요.',
        errors: this.errors,
      });
    }
  }
}

export function todayString() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 주소의 번호(:id)를 검사해요. */
export function parseId(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException({ message: '잘못된 주소예요. 목록에서 다시 선택해 주세요.' });
  }
  return n;
}

/** 검색어: % 와 _ 를 글자 그대로 찾도록 처리 */
export function likePattern(q: unknown) {
  const text = typeof q === 'string' ? q.trim() : '';
  if (!text) return null;
  return `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

/** 받침 유무에 따라 을/를, 은/는 을 알맞게 붙여요. */
export function josa(word: string, type: '을' | '은') {
  const last = word.charCodeAt(word.length - 1);
  const hasBatchim = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0;
  const pair = type === '을' ? ['을', '를'] : ['은', '는'];
  return word + (hasBatchim ? pair[0] : pair[1]);
}
