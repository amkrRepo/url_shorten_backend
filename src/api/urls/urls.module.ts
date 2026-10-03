import { Module } from '@nestjs/common';
import { UrlsController } from './urls.controller';
import { UrlsService } from './urls.service';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  controllers: [UrlsController],
  providers: [UrlsService],
})
export class UrlsModule {}
