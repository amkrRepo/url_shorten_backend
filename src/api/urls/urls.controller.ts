import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { UrlDetailsDto } from './dto/urls.dto';
import { UrlsService } from './urls.service';
import type { Response } from 'express';
@Controller('urls')
export class UrlsController {
  constructor(private readonly urlsService: UrlsService) {}

  @Get('details')
  @HttpCode(HttpStatus.ACCEPTED)
  getUrlDetails(@Query('short_code') short_code: string) {
    return this.urlsService.getUrlDetails(short_code);
  }

  @Post('shorten')
  @HttpCode(HttpStatus.CREATED)
  async shorten(@Body() dto: UrlDetailsDto) {
    return this.urlsService.createShortUrl(dto);
  }

  @Get('redirect')
  async redirect(
    @Query('short_code') short_code: string,
    @Res() res: Response,
  ) {
    if (!short_code) {
      throw new BadRequestException('short_code query parameter is required');
    }

    const url = await this.urlsService.findByShortCode(short_code);

    res.redirect(HttpStatus.FOUND, url.original_url);
  }
}
