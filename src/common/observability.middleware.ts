import { Injectable, NestMiddleware } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/guards/api-key.guard';

const SLOW_REQUEST_MS = 1000;

export function toSentryUser(user: AuthenticatedRequest['user']) {
  return {
    id: String(user.id),
    email: user.email,
    username: user.name,
    tier: user.tier,
  };
}

@Injectable()
export class ObservabilityMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();

    const scope = Sentry.getIsolationScope();

    const user = (req as Partial<AuthenticatedRequest>).user;
    if (user) {
      Sentry.setUser(toSentryUser(user));
    }

    Sentry.setTags({
      'http.method': req.method,
      'http.route': req.originalUrl,
    });
    Sentry.addBreadcrumb({
      category: 'http',
      type: 'http',
      data: { method: req.method, url: req.originalUrl },
    });

    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      const summary = `${req.method} ${req.originalUrl} -> ${res.statusCode} in ${elapsedMs.toFixed(0)}ms`;

      Sentry.withIsolationScope(scope, () => {
        if (res.statusCode >= 500) {
          Sentry.captureMessage(summary, 'error');
        } else if (elapsedMs > SLOW_REQUEST_MS) {
          Sentry.captureMessage(summary, 'warning');
        }
      });
    });

    next();
  }
}
