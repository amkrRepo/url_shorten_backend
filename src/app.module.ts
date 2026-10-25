import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UrlsModule } from './api/urls/urls.module';
import { DbModule } from './db/db.module';
import { UserModule } from './api/user/user.module';
import { HealthModule } from './health/health.module';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { BlacklistService } from './common/blacklist.service';
import { BlacklistMiddleware } from './common/blacklist.middleware';
import { ResponseTimeMiddleware } from './common/response-time.middleware';
import { ObservabilityMiddleware } from './common/observability.middleware';
import { UrlsV1Controller, UrlsV2Controller } from './api/urls/urls.controller';

@Module({
  imports: [
    SentryModule.forRoot(),
    UrlsModule,
    DbModule,
    UserModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    AppService,
    BlacklistService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Blocked keys are rejected first, before any other API key handling.
    consumer.apply(BlacklistMiddleware).forRoutes('*');

    consumer
      .apply(RequestLoggerMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes(UrlsV1Controller, UrlsV2Controller, 'user');

    consumer.apply(ResponseTimeMiddleware).forRoutes('*');

    // Auth is a guard, so req.user is empty here; APIKeyGuard sets the Sentry
    // user itself.
    consumer.apply(ObservabilityMiddleware).forRoutes('*');
  }
}
