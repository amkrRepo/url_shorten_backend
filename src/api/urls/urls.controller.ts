import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  BatchShortenDto,
  DeleteShortCode,
  UpdateShortCodeDto,
  UrlDetailsDto,
} from './dto/urls.dto';
import { UrlsService } from './urls.service';
import type { Response } from 'express';
import { APIKeyGuard } from '../../auth/guards/api-key.guard';
import type { AuthenticatedRequest } from '../../auth/guards/api-key.guard';
import { TierGuard } from '../../auth/guards/tier.guard';

// @Injectable() makes TS emit the constructor's param types; without a
// decorator here the v1/v2 subclasses get no UrlsService injected.
@Injectable()
abstract class UrlsController {
  constructor(readonly urlsService: UrlsService) {}

  /**
   * `?short_code=a&short_code=b` (or a missing param) makes Express give
   * an array/undefined instead of a string, which Prisma rejects with a
   * validation error that would surface as a 500. Normalize it to a
   * 400 here instead.
   */
  requireShortCode(short_code: string | string[]): string {
    if (typeof short_code !== 'string' || short_code.length === 0) {
      throw new BadRequestException('short_code query parameter is required');
    }

    return short_code;
  }

  /**
   * `?password=a&password=b` (or `?password=`) makes Express give an array
   * or an empty string instead of the single password. Normalize both to
   * `undefined` so a protected short_code reports 403 instead of being
   * compared against a malformed value.
   */
  private optionalPassword(
    password: string | string[] | undefined,
  ): string | undefined {
    return typeof password === 'string' && password.length > 0
      ? password
      : undefined;
  }

  @Get('details')
  @HttpCode(HttpStatus.ACCEPTED)
  getUrlDetails(@Query('short_code') short_code: string | string[]) {
    return this.urlsService.getUrlDetails(this.requireShortCode(short_code));
  }

  @Get('list')
  @UseGuards(APIKeyGuard)
  list(@Req() req: AuthenticatedRequest) {
    return this.urlsService.listUserUrls(req.user.id);
  }

  @Get('redirect')
  @HttpCode(HttpStatus.PERMANENT_REDIRECT)
  async redirect(
    @Query('short_code') short_code: string | string[],
    @Query('password') password: string | string[] | undefined,
    @Res() res: Response,
  ) {
    const code = this.requireShortCode(short_code);

    const url = await this.urlsService.findByShortCode(
      code,
      this.optionalPassword(password),
    );

    res.redirect(HttpStatus.FOUND, url.original_url);
  }
}

// Controller for v1.
@Controller({ path: 'urls', version: '1' })
export class UrlsV1Controller extends UrlsController {
  @Post('shorten')
  @HttpCode(HttpStatus.CREATED)
  async shorten(@Body() dto: UrlDetailsDto) {
    return this.urlsService.createShortUrl(dto);
  }
}

// Controller for v2.

@Controller({ path: 'urls', version: '2' })
export class UrlsV2Controller extends UrlsController {
  @Post('shorten')
  @UseGuards(APIKeyGuard)
  @HttpCode(HttpStatus.CREATED)
  shorten(@Body() dto: UrlDetailsDto, @Req() req: AuthenticatedRequest) {
    return this.urlsService.createShortUrl(dto, req.user.id);
  }

  @Post('shorten/batch')
  @UseGuards(APIKeyGuard, TierGuard)
  @HttpCode(207)
  shortenBatch(@Body() dto: BatchShortenDto, @Req() req: AuthenticatedRequest) {
    return this.urlsService.createShortUrlsBatch(dto.urls, req.user.id);
  }

  @Delete('delete')
  @UseGuards(APIKeyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Query('short_code') short_code: string | string[],
    @Body() dto: DeleteShortCode,
    @Req() req: AuthenticatedRequest,
  ) {
    const code = this.requireShortCode(short_code);

    await this.urlsService.deleteByShortCode({
      short_code: code,
      userId: req.user.id,
      password: dto?.password,
    });
  }

  @Patch('update')
  @UseGuards(APIKeyGuard)
  @HttpCode(HttpStatus.OK)
  async update(
    @Query('short_code') short_code: string | string[],
    @Body() dto: UpdateShortCodeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const code = this.requireShortCode(short_code);

    return this.urlsService.updateShortCode({
      short_code: code,
      new_short_code: dto.new_short_code,
      userId: req.user.id,
      password: dto.password,
      clearPassword: dto.clearPassword,
    });
  }
}
