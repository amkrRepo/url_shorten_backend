import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthenticatedRequest } from './api-key.guard';

@Injectable()
export class TierGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tier = req.user?.tier;

    if (tier !== 'enterprise') {
      throw new ForbiddenException('Upgrade to enterprise');
    }

    return true;
  }
}
