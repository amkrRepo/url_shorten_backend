import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import { UpdateTierDto, UsersDto } from './dto/user.dto';
import { UserService } from './user.service';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  createUser(@Body() dto: UsersDto) {
    return this.userService.createNewUser(dto);
  }

  @Patch('tier')
  @HttpCode(HttpStatus.OK)
  updateTier(@Body() dto: UpdateTierDto) {
    return this.userService.updateUserTier(dto.email, dto.tier);
  }
}
