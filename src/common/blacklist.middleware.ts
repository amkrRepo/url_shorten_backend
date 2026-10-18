import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { BlacklistService } from './blacklist.service';
import { TimeMiddleware } from './timed-middleware.decorator';

@Injectable()
export class BlacklistMiddleware implements NestMiddleware {
  constructor(private readonly blacklistService: BlacklistService) {}

  @TimeMiddleware()
  use(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers['x-api-key'];

    if (typeof apiKey === 'string' && this.blacklistService.isBlocked(apiKey)) {
      res.status(403).json({ message: 'This API key has been blocked' });
      return;
    }

    next();
  }
}
