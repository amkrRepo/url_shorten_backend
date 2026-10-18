import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
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

@Module({
  imports: [UrlsModule, DbModule, UserModule, HealthModule],
  controllers: [AppController],
  providers: [AppService, BlacklistService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Blocked keys are rejected first, before any other API key handling.
    consumer.apply(BlacklistMiddleware).forRoutes('*');

    consumer
      .apply(RequestLoggerMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('urls', 'user');

    consumer.apply(ResponseTimeMiddleware).forRoutes('*');
  }
}
