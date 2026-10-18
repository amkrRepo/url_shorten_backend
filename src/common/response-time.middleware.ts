import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TimeMiddleware } from './timed-middleware.decorator';

@Injectable()
export class ResponseTimeMiddleware implements NestMiddleware {
  @TimeMiddleware()
  use(req: any, res: any, next: (error?: any) => void) {
    // Store the start time.
    const start = process.hrtime.bigint();

    // referencing the res.writeHead into a variable
    const originalWriteHead = res.writeHead;

    // Replacing the writeHead func with a wrapper containing originalWriteHead
    res.writeHead = function (this: Response, ...args: any[]) {
      // calculate the elapsed time and set in header.
      const elapsedTime = Number(process.hrtime.bigint() - start) / 1e6;
      this.setHeader('X-Response-Time', `${elapsedTime.toFixed(2)}ms`);

      return originalWriteHead.apply(this, args as any);
    } as typeof res.writeHead;

    next();
  }
}
