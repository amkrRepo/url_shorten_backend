import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { UsersDto } from './dto/user.dto';

@Injectable()
export class UserService {
  constructor(private readonly dbService: DbService) {}

  async findUserByApiKey(key: string) {
    return this.dbService.users.findUnique({
      where: { api_key: key },
    });
  }

  createNewUser(dto: UsersDto) {
    // Explicit field pick: the global ValidationPipe in main.ts does not
    // enable `whitelist`, so unknown body keys would otherwise survive
    // validation and reach Prisma. Tier can only be assigned via
    // updateUserTier, never at signup.
    return this.dbService.users.create({
      data: {
        email: dto.email,
        name: dto.name,
        api_key: dto.api_key,
      },
    });
  }

  async updateUserTier(email: string, tier: 'enterprise') {
    if (tier !== 'enterprise') {
      throw new BadRequestException(
        'Only free to enterprise upgrades are supported',
      );
    }

    const user = await this.dbService.users.findUnique({ where: { email } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.tier === 'enterprise') {
      return user;
    }

    return this.dbService.users.update({
      where: { email },
      data: { tier: 'enterprise' },
    });
  }
}
