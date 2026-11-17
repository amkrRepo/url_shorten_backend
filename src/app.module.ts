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
import { RedisModule } from './redis/redis.module';
import { UserModule } from './api/user/user.module';
import { HealthModule } from './health/health.module';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { BlacklistService } from './common/blacklist.service';
import { BlacklistMiddleware } from './common/blacklist.middleware';
import { ResponseTimeMiddleware } from './common/response-time.middleware';
import { ObservabilityMiddleware } from './common/observability.middleware';
import { RateLimitMiddleware } from './common/rate-limit.middleware';
import {
  RATE_LIMIT_OPTIONS,
  RateLimitService,
  rateLimitOptionsFromEnv,
} from './common/rate-limit.service';
import { UrlsV1Controller, UrlsV2Controller } from './api/urls/urls.controller';

@Module({
  imports: [
    SentryModule.forRoot(),
    UrlsModule,
    DbModule,
    RedisModule,
    UserModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    AppService,
    BlacklistService,
    { provide: RATE_LIMIT_OPTIONS, useFactory: rateLimitOptionsFromEnv },
    RateLimitService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Blocked keys are rejected first, before any other API key handling.
    consumer.apply(BlacklistMiddleware).forRoutes('*');

    // Per-IP request limit (default 100/min). Health checks are exempt so
    // monitors never get throttled.
    consumer
      .apply(RateLimitMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');

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
