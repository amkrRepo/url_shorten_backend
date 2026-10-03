import {
  IsUrl,
  IsNotEmpty,
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
} from 'class-validator';

const CUSTOM_CODE_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

export const BATCH_MAX_SIZE = 100;

export class UrlDetailsDto {
  @IsNotEmpty()
  @IsUrl()
  original_url!: string;

  @IsOptional()
  @IsDateString()
  expiry_date?: string;

  @IsOptional()
  @IsString()
  @Matches(CUSTOM_CODE_PATTERN, {
    message:
      'custom_code must be 3-30 characters long and contain only letters, numbers, "-" or "_"',
  })
  custom_code?: string;
}

/**
 * Structural validation only: an entry that is not a valid URL must not
 * reject the whole batch, it becomes a per-entry failure instead.
 */
export class BatchShortenDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BATCH_MAX_SIZE)
  @IsString({ each: true })
  urls!: string[];
}
