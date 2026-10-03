import { Injectable } from '@nestjs/common';
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
    return this.dbService.users.create({
      data: dto,
    });
  }
}
