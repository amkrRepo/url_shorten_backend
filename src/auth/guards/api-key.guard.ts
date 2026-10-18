import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Request } from 'express';
import { users } from 'generated/prisma/browser';
import { UserService } from '../../api/user/user.service';
import { toSentryUser } from '../../common/observability.middleware';

export interface AuthenticatedRequest extends Request {
  user: users;
}

@Injectable()
export class APIKeyGuard implements CanActivate {
  constructor(private readonly userService: UserService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = req.headers['x-api-key'];

    if (!token || Array.isArray(token)) {
      throw new UnauthorizedException('API Key is required');
    }

    const user = await this.userService.findUserByApiKey(token);

    if (!user) {
      throw new UnauthorizedException('Invalid api key');
    }

    req.user = user;
    Sentry.setUser(toSentryUser(user));

    return true;
  }
}
