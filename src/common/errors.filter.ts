import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';

/** 예상하지 못한 오류도 쉬운 말로 돌려줘요. (DB 주소 같은 내부 내용은 보여 주지 않아요) */
@Catch()
export class FriendlyErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    const code = (exception as any)?.code;
    if (code === '23505') {
      res.status(409).json({ statusCode: 409, message: '이미 등록된 내용이에요. 목록에서 확인해 주세요.' });
      return;
    }
    if (code === '23503') {
      res.status(409).json({ statusCode: 409, message: '다른 정보와 연결되어 있어서 처리할 수 없어요.' });
      return;
    }
    // body 가 너무 크거나(사진) 잘못된 JSON 일 때
    const status = (exception as any)?.status ?? (exception as any)?.statusCode;
    if (status === 413) {
      res.status(413).json({ statusCode: 413, message: '보낸 내용이 너무 커요. 사진은 5MB 이하로 올려 주세요.' });
      return;
    }
    if (status === 400) {
      res.status(400).json({ statusCode: 400, message: '보낸 내용을 읽을 수 없어요. 다시 시도해 주세요.' });
      return;
    }

    console.error('예상하지 못한 오류:', exception);
    res.status(500).json({ statusCode: 500, message: '서버에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.' });
  }
}
