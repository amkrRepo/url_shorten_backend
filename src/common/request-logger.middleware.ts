import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DbService } from '../db/db.service';
import { TimeMiddleware } from './timed-middleware.decorator';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  constructor(private readonly dbService: DbService) {}

  @TimeMiddleware()
  async use(req: Request, _res: Response, next: NextFunction) {
    try {
      await this.dbService.request_logs.create({
        data: {
          time_stamp: new Date(),
          http_method: req.method,
          url: req.originalUrl,
          user_agent: req.get('user-agent') ?? null,
          ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
        },
      });
    } catch (err) {
      console.error('Failed to write request log', err);
    }

    next();
  }
}
