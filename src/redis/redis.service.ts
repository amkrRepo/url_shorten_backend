import 'dotenv/config';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService
  extends Redis
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisService.name);

  constructor() {
    super(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,

      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
    });

    this.on('error', (error: Error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  async onModuleInit() {
    try {
      await this.connect();
    } catch (error) {
      this.logger.error(
        'Could not connect to Redis at startup; redirects will use the DB until it is reachable',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async onModuleDestroy() {
    if (this.status === 'ready') {
      await this.quit();
    } else {
      this.disconnect();
    }
  }
}
