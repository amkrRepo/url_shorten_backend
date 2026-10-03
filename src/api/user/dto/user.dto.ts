import { IsEmail, IsNotEmpty } from 'class-validator';

export class UsersDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsNotEmpty()
  name!: string;

  @IsNotEmpty()
  api_key!: string;
}
