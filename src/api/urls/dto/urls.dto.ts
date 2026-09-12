import { IsUrl, IsNotEmpty } from 'class-validator';

export class UrlDetailsDto {
  @IsNotEmpty()
  @IsUrl()
  original_url!: string;
}
