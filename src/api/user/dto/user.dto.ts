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

  // Only free -> enterprise is supported; there is no downgrade path, so
  // 'free' is not a valid target.
  @IsIn(['enterprise'])
  tier!: 'enterprise';
}
