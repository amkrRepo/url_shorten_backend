import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { UrlDetailsDto } from './dto/urls.dto';
import { UrlsService } from './urls.service';

@Controller('urls')
export class UrlsController {
  constructor(private readonly urlsService: UrlsService) {}

  @Get('details')
  getUrlDetails(@Query('short_code') short_code: string) {
    return this.urlsService.getUrlDetails(short_code);
  }

  @Post('shorten')
  createShortUrl(@Body() urlDetails: UrlDetailsDto) {
    return this.urlsService.createShortUrl(urlDetails);
  }
}
