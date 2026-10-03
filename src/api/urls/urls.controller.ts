import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { UrlDetailsDto } from './dto/urls.dto';
import { UrlsService } from './urls.service';
import type { Response } from 'express';
import { APIKeyGuard } from '../../auth/guards/api-key.guard';
import type { AuthenticatedRequest } from '../../auth/guards/api-key.guard';
@Controller('urls')
export class UrlsController {
  constructor(private readonly urlsService: UrlsService) {}

  /**
   * `?short_code=a&short_code=b` (or a missing param) makes Express give
   * an array/undefined instead of a string, which Prisma rejects with a
   * validation error that would surface as a 500. Normalize it to a
   * 400 here instead.
   */
  private requireShortCode(short_code: string | string[]): string {
    if (typeof short_code !== 'string' || short_code.length === 0) {
      throw new BadRequestException('short_code query parameter is required');
    }

    return short_code;
  }

  @Get('details')
  @HttpCode(HttpStatus.ACCEPTED)
  getUrlDetails(@Query('short_code') short_code: string | string[]) {
    return this.urlsService.getUrlDetails(this.requireShortCode(short_code));
  }

  @Post('shorten')
  @UseGuards(APIKeyGuard)
  @HttpCode(HttpStatus.CREATED)
  shorten(@Body() dto: UrlDetailsDto, @Req() req: AuthenticatedRequest) {
    return this.urlsService.createShortUrl(dto, req.user.id);
  }

  @Get('redirect')
  @HttpCode(HttpStatus.PERMANENT_REDIRECT)
  async redirect(
    @Query('short_code') short_code: string | string[],
    @Res() res: Response,
  ) {
    const code = this.requireShortCode(short_code);

    const url = await this.urlsService.findByShortCode(code);

    res.redirect(HttpStatus.FOUND, url.original_url);
  }

  @Delete('delete')
  @UseGuards(APIKeyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Query('short_code') short_code: string | string[],
    @Req() req: AuthenticatedRequest,
  ) {
    const code = this.requireShortCode(short_code);

    await this.urlsService.deleteByShortCode({
      short_code: code,
      userId: req.user.id,
    });
  }
}
