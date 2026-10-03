import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { UsersDto } from './dto/user.dto';
import { UserService } from './user.service';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  createUser(@Body() dto: UsersDto) {
    return this.userService.createNewUser(dto);
  }
}
