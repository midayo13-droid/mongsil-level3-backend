import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { FriendlyErrorFilter } from './common/errors.filter.js';
import { initDatabase, syncHolidays } from './common/schema.js';
import { kstNow } from './common/time.js';

async function bootstrap() {
  // 테이블이 없으면 만들고, 비어 있으면 가상 데이터를 채워 넣어요.
  await initDatabase();

  // 올해와 내년의 공휴일을 무료 공휴일 API에서 불러와 휴무일에 넣어요. (실패해도 서버는 켜져요)
  const thisYear = Number(kstNow().date.slice(0, 4));
  await syncHolidays(thisYear);
  await syncHolidays(thisYear + 1);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 사진(최대 5MB)을 글자로 바꿔 보내므로 받는 크기를 넉넉히 늘려요.
  app.useBodyParser('json', { limit: '8mb' });
  app.useGlobalFilters(new FriendlyErrorFilter());

  const origins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length > 0 ? origins : true });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`서버가 켜졌어요: http://localhost:${port}  (확인: /health)`);
}
await bootstrap();
