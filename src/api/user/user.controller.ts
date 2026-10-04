import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UpdateTierDto, UsersDto } from './dto/user.dto';
import { UserService } from './user.service';
import { TierGuard } from '../../auth/guards/tier.guard';
import { APIKeyGuard } from '../../auth/guards/api-key.guard';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  createUser(@Body() dto: UsersDto) {
    return this.userService.createNewUser(dto);
  }

  @Patch('tier')
  @UseGuards(APIKeyGuard, TierGuard)
  @HttpCode(HttpStatus.OK)
  updateTier(@Body() dto: UpdateTierDto) {
    return this.userService.updateUserTier(dto.email, dto.tier);
  }
}
