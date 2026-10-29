import { ALL_ROLES, ROLE_ADMIN, Roles } from '../auth/auth.js';
import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { query, queryOne } from '../common/db.js';
import { listOrAll, parsePaging } from '../common/pagination.js';
import { Checker, likePattern, parseId } from '../common/validation.js';

/** 공지사항 첨부파일로 올릴 수 있는 종류 (확장자 → 파일 종류) */
const NOTICE_FILE_KINDS: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp',
  zip: 'application/zip',
};
const MAX_NOTICE_FILES = 3;
/** 이벤트 이미지로 올릴 수 있는 종류 */
const EVENT_IMAGE_KINDS: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 공지사항 */
@Controller('notices')
export class NoticesController {
  private check(body: any) {
    const c = new Checker();
    const value = {
      title: c.text(body, 'title', '제목', { required: true, max: 50 }),
      content: c.text(body, 'content', '내용', { required: true, max: 1000 }),
    };
    c.done();
    return value;
  }

  @Roles(...ALL_ROLES)
  @Get()
  list(@Query('q') q?: string, @Query('page') page?: string, @Query('size') size?: string) {
    return listOrAll(
      parsePaging(page, size),
      `SELECT n.id, n.title, n.content, n.created_at,
              (SELECT COUNT(*)::int FROM notice_files f WHERE f.notice_id = n.id) AS file_count
         FROM notices n
        WHERE $1::text IS NULL OR n.title ILIKE $1
        ORDER BY n.created_at DESC, n.id DESC`,
      [likePattern(q)],
    );
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  async detail(@Param('id') idText: string) {
    const row = await queryOne('SELECT * FROM notices WHERE id = $1', [parseId(idText)]);
    if (!row) throw new NotFoundException('공지사항을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    const files = await query('SELECT id, name, size FROM notice_files WHERE notice_id = $1 ORDER BY id', [row.id]);
    return { ...row, files };
  }

  /** 첨부파일 내려받기 */
  @Roles(...ALL_ROLES)
  @Get(':id/files/:fileId')
  async download(@Param('id') idText: string, @Param('fileId') fileIdText: string) {
    const row = await queryOne<{ name: string; mime: string; data: Buffer }>(
      'SELECT name, mime, data FROM notice_files WHERE id = $1 AND notice_id = $2',
      [parseId(fileIdText), parseId(idText)],
    );
    if (!row) throw new NotFoundException('첨부파일을 찾을 수 없어요. 이미 지워졌을 수 있어요.');
    return new StreamableFile(row.data, {
      type: row.mime,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    });
  }

  /** 첨부파일 올리기 (공지당 3개까지, 한 개 5MB 이하) */
  @Roles(ROLE_ADMIN)
  @Post(':id/files')
  async upload(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    const c = new Checker();
    const file = c.file(body, NOTICE_FILE_KINDS, '첨부파일');
    c.done();
    const notice = await queryOne('SELECT id FROM notices WHERE id = $1', [id]);
    if (!notice) throw new NotFoundException('공지사항을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    const count = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM notice_files WHERE notice_id = $1', [id]);
    if ((count?.n ?? 0) >= MAX_NOTICE_FILES) {
      c.fail('file', `첨부파일은 공지 하나에 ${MAX_NOTICE_FILES}개까지 올릴 수 있어요.`);
      c.done();
    }
    return queryOne(
      'INSERT INTO notice_files (notice_id, name, mime, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, size',
      [id, file!.name, file!.mime, file!.buffer.length, file!.buffer],
    );
  }

  @Roles(ROLE_ADMIN)
  @Delete(':id/files/:fileId')
  async removeFile(@Param('id') idText: string, @Param('fileId') fileIdText: string) {
    const rows = await query('DELETE FROM notice_files WHERE id = $1 AND notice_id = $2 RETURNING id', [
      parseId(fileIdText),
      parseId(idText),
    ]);
    if (rows.length === 0) throw new NotFoundException('첨부파일을 찾을 수 없어요. 이미 지워졌을 수 있어요.');
    return { message: '삭제했어요.' };
  }

  @Roles(ROLE_ADMIN)
  @Post()
  create(@Body() body: any) {
    const v = this.check(body);
    return queryOne('INSERT INTO notices (title, content) VALUES ($1,$2) RETURNING *', [v.title, v.content]);
  }

  @Roles(ROLE_ADMIN)
  @Put(':id')
  async update(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    const v = this.check(body);
    const row = await queryOne('UPDATE notices SET title=$1, content=$2 WHERE id=$3 RETURNING *', [
      v.title,
      v.content,
      id,
    ]);
    if (!row) throw new NotFoundException('공지사항을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    return row;
  }

  @Roles(ROLE_ADMIN)
  @Delete(':id')
  async remove(@Param('id') idText: string) {
    const rows = await query('DELETE FROM notices WHERE id = $1 RETURNING id', [parseId(idText)]);
    if (rows.length === 0) throw new NotFoundException('공지사항을 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    return { message: '삭제했어요.' };
  }
}

/** 이벤트 */
@Controller('events')
export class EventsController {
  private check(body: any) {
    const c = new Checker();
    const value = {
      title: c.text(body, 'title', '제목', { required: true, max: 50 }),
      content: c.text(body, 'content', '내용', { required: true, max: 1000 }),
      start_date: c.date(body, 'start_date', '시작일', { required: true }),
      end_date: c.date(body, 'end_date', '종료일', { required: true }),
      link_url: c.url(body, 'link_url', '링크'),
    };
    if (value.start_date && value.end_date && value.end_date < value.start_date) {
      c.fail('end_date', '종료일은 시작일 이후로 골라 주세요.');
    }
    c.done();
    return value;
  }

  @Roles(...ALL_ROLES)
  @Get()
  list(@Query('q') q?: string, @Query('page') page?: string, @Query('size') size?: string) {
    return listOrAll(
      parsePaging(page, size),
      `SELECT e.id, e.title, e.content, e.start_date, e.end_date, e.created_at,
              (CURRENT_DATE BETWEEN e.start_date AND e.end_date) AS ongoing,
              x.link_url, (x.image_data IS NOT NULL) AS has_image
         FROM events e LEFT JOIN event_extras x ON x.event_id = e.id
        WHERE $1::text IS NULL OR e.title ILIKE $1
        ORDER BY e.start_date DESC, e.id DESC`,
      [likePattern(q)],
    );
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  async detail(@Param('id') idText: string) {
    const row = await queryOne(
      `SELECT e.*, (CURRENT_DATE BETWEEN e.start_date AND e.end_date) AS ongoing,
              x.link_url, (x.image_data IS NOT NULL) AS has_image, x.image_name
         FROM events e LEFT JOIN event_extras x ON x.event_id = e.id WHERE e.id = $1`,
      [parseId(idText)],
    );
    if (!row) throw new NotFoundException('이벤트를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    return row;
  }

  /** 이벤트 이미지 보기 */
  @Roles(...ALL_ROLES)
  @Get(':id/image')
  async image(@Param('id') idText: string) {
    const row = await queryOne<{ image_type: string; image_data: Buffer }>(
      'SELECT image_type, image_data FROM event_extras WHERE event_id = $1 AND image_data IS NOT NULL',
      [parseId(idText)],
    );
    if (!row) throw new NotFoundException('등록된 이미지가 없어요.');
    return new StreamableFile(row.image_data, { type: row.image_type, disposition: 'inline' });
  }

  /** 이벤트 이미지 올리기(바꾸기). 5MB 이하 jpg, png, gif, webp */
  @Roles(ROLE_ADMIN)
  @Put(':id/image')
  async uploadImage(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    const c = new Checker();
    const file = c.file(body, EVENT_IMAGE_KINDS, '이미지');
    c.done();
    const event = await queryOne('SELECT id FROM events WHERE id = $1', [id]);
    if (!event) throw new NotFoundException('이벤트를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    await query(
      `INSERT INTO event_extras (event_id, image_name, image_type, image_data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id) DO UPDATE SET image_name=$2, image_type=$3, image_data=$4`,
      [id, file!.name, file!.mime, file!.buffer],
    );
    return { message: '이미지를 올렸어요.' };
  }

  @Roles(ROLE_ADMIN)
  @Delete(':id/image')
  async removeImage(@Param('id') idText: string) {
    await query(
      'UPDATE event_extras SET image_name = NULL, image_type = NULL, image_data = NULL WHERE event_id = $1',
      [parseId(idText)],
    );
    return { message: '이미지를 지웠어요.' };
  }

  private saveLink(id: number, link: string | null) {
    return query(
      'INSERT INTO event_extras (event_id, link_url) VALUES ($1,$2) ON CONFLICT (event_id) DO UPDATE SET link_url = $2',
      [id, link],
    );
  }

  @Roles(ROLE_ADMIN)
  @Post()
  async create(@Body() body: any) {
    const v = this.check(body);
    const row = await queryOne(
      'INSERT INTO events (title, content, start_date, end_date) VALUES ($1,$2,$3,$4) RETURNING *',
      [v.title, v.content, v.start_date, v.end_date],
    );
    if (v.link_url) await this.saveLink(row.id, v.link_url);
    return { ...row, link_url: v.link_url };
  }

  @Roles(ROLE_ADMIN)
  @Put(':id')
  async update(@Param('id') idText: string, @Body() body: any) {
    const id = parseId(idText);
    const v = this.check(body);
    const row = await queryOne(
      'UPDATE events SET title=$1, content=$2, start_date=$3, end_date=$4 WHERE id=$5 RETURNING *',
      [v.title, v.content, v.start_date, v.end_date, id],
    );
    if (!row) throw new NotFoundException('이벤트를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    await this.saveLink(id, v.link_url);
    return { ...row, link_url: v.link_url };
  }

  @Roles(ROLE_ADMIN)
  @Delete(':id')
  async remove(@Param('id') idText: string) {
    const rows = await query('DELETE FROM events WHERE id = $1 RETURNING id', [parseId(idText)]);
    if (rows.length === 0) throw new NotFoundException('이벤트를 찾을 수 없어요. 이미 삭제되었을 수 있어요.');
    return { message: '삭제했어요.' };
  }
}
