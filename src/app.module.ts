import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UrlsModule } from './api/urls/urls.module';
import { DbModule } from './db/db.module';
import { UserModule } from './api/user/user.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [UrlsModule, DbModule, UserModule, HealthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
