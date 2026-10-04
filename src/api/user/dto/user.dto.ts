import { IsEmail, IsIn, IsNotEmpty } from 'class-validator';

export class UsersDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsNotEmpty()
  name!: string;

  @IsNotEmpty()
  api_key!: string;
}

export class UpdateTierDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsIn(['free', 'enterprise'])
  tier!: 'free' | 'enterprise';
}
