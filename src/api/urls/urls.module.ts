import { Module } from '@nestjs/common';
import { UrlsV1Controller, UrlsV2Controller } from './urls.controller';
import { UrlsService } from './urls.service';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  controllers: [UrlsV1Controller, UrlsV2Controller],
  providers: [UrlsService],
})
export class UrlsModule {}
