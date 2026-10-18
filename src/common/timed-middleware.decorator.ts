// src/common/time-middleware.decorator.ts
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export function TimeMiddleware(): MethodDecorator {
  return (target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    const name = target.constructor.name; // e.g. "AuthenticationMiddleware"
    const logger = new Logger('MiddlewareTimer');

    descriptor.value = async function (
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      const start = process.hrtime.bigint();
      let logged = false;

      const logTime = () => {
        if (logged) return; // make sure we log only once
        logged = true;
        const elapsedTime = Number(process.hrtime.bigint() - start) / 1e6;
        logger.log(`${name} took ${elapsedTime.toFixed(2)}ms`);
      };

      // Case 1: middleware calls next() -> stop the clock there
      const wrappedNext: NextFunction = (err?: any) => {
        logTime();
        next(err);
      };

      // Case 2: middleware sends a response itself (e.g. 401) and never calls next
      res.once('finish', logTime);

      try {
        await original.call(this, req, res, wrappedNext);
      } catch (err) {
        logTime(); // middleware threw an error
        throw err;
      }
    };
  };
}
