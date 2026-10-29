import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { StatsController } from './admin/stats.controller.js';
import { AiController } from './ai/ai.controller.js';
import { AppController } from './app.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.js';
import { EventsController, NoticesController } from './boards/boards.controller.js';
import { CustomerController } from './customer/customer.controller.js';
import { DogsController } from './dogs/dogs.controller.js';
import { GroomersController } from './groomers/groomers.controller.js';
import { GuardiansController } from './guardians/guardians.controller.js';
import { RecordsController } from './records/records.controller.js';
import { ClosedDaysController } from './reservations/closed-days.controller.js';
import { ReservationsController } from './reservations/reservations.controller.js';

@Module({
  controllers: [
    AppController,
    AuthController,
    GuardiansController,
    DogsController,
    GroomersController,
    RecordsController,
    NoticesController,
    EventsController,
    ReservationsController,
    ClosedDaysController,
    StatsController,
    AiController,
    CustomerController,
  ],
  // 모든 주소에서 로그인과 역할을 서버가 확인해요. (/health 와 로그인만 예외)
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
