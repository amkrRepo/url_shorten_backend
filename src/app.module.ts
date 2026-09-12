import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UrlsModule } from './api/urls/urls.module';
import { DbModule } from './db/db.module';

@Module({
  imports: [UrlsModule, DbModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
