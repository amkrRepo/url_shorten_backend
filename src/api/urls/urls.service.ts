import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isURL } from 'class-validator';
import { DbService } from '../../db/db.service';
import type { UrlDetailsDto } from './dto/urls.dto';
import type { urlsModel } from 'generated/prisma/models/urls';
import { generateShortCode } from '../../common/short-code-utils';

const MAX_GENERATION_ATTEMPTS = 5;

export interface BatchShortenSuccess extends urlsModel {
  index: number;
}

export interface BatchShortenFailure {
  index: number;
  original_url: string;
  message: string;
}

export interface BatchShortenResult {
  total: number;
  successful: BatchShortenSuccess[];
  failed: BatchShortenFailure[];
}
@Injectable()
export class UrlsService {
  constructor(private readonly dbService: DbService) {}

  async getUrlDetails(short_code: string) {
    const urlDetails = await this.dbService.urls.findUnique({
      where: { short_code },
    });

    if (!urlDetails || urlDetails.deleted_at) {
      throw new NotFoundException('URL not found');
    }

    if (this.isExpired(urlDetails.expiry_date)) {
      throw new GoneException('This URL has expired');
    }

    return urlDetails;
  }

  async createShortUrl(
    dto: UrlDetailsDto,
    userId?: number,
  ): Promise<urlsModel> {
    if (this.isExpired(dto.expiry_date)) {
      throw new GoneException('This URL has expired');
    }

    const expiry_date = dto.expiry_date ? new Date(dto.expiry_date) : null;

    // A user-requested code has no fallback: a collision means the code is
    // already taken, so it surfaces as 409 instead of being retried.
    if (dto.custom_code) {
      try {
        return await this.dbService.urls.create({
          data: {
            original_url: dto.original_url,
            short_code: dto.custom_code,
            user_id: userId ?? null,
            expiry_date,
          },
        });
      } catch (error) {
        if (this.isUniqueConstraintViolation(error)) {
          throw new ConflictException(
            `custom_code "${dto.custom_code}" is already taken`,
          );
        }
        throw error;
      }
    }

    // Every request creates a fresh row with its own short_code, even
    // when the original_url has been shortened before. The only unique
    // constraint is short_code, so the only failure worth retrying is a
    // generated-code collision.
    return this.createGeneratedUrl(dto.original_url, userId, expiry_date);
  }

  /**
   * Shortens every entry independently so one bad URL never blocks the
   * rest of the batch. Each entry is pushed onto `successful` (and
   * persisted) or onto `failed` with the reason, and both lists are
   * returned so the client can reconcile them by `index`.
   */
  async createShortUrlsBatch(
    urls: string[],
    userId?: number,
  ): Promise<BatchShortenResult> {
    const successful: BatchShortenSuccess[] = [];
    const failed: BatchShortenFailure[] = [];

    for (const [index, original_url] of urls.entries()) {
      if (!isURL(original_url)) {
        failed.push({
          index,
          original_url,
          message: 'original_url is not a valid URL',
        });
        continue;
      }

      try {
        const url = await this.createGeneratedUrl(original_url, userId, null);
        successful.push({ index, ...url });
      } catch (error) {
        failed.push({
          index,
          original_url,
          message: this.failureMessage(error),
        });
      }
    }

    return { total: urls.length, successful, failed };
  }

  private async createGeneratedUrl(
    original_url: string,
    userId?: number,
    expiry_date: Date | null = null,
  ): Promise<urlsModel> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const short_code = generateShortCode();
      try {
        return await this.dbService.urls.create({
          data: {
            original_url,
            short_code,
            user_id: userId ?? null,
            expiry_date,
          },
        });
      } catch (error) {
        if (!this.isUniqueConstraintViolation(error)) {
          // Not a collision — a real DB error. Let it bubble up as a 500.
          throw error;
        }

        // short_code is the only unique constraint, so this collision is
        // a duplicate generated code. Loop and try a fresh one.
        lastError = error;
      }
    }

    throw lastError;
  }

  private failureMessage(error: unknown): string {
    return error instanceof HttpException
      ? error.message
      : 'Failed to shorten the URL';
  }

  /**
   * Looks up a live (not soft-deleted) URL by its short_code and records
   * the visit. Throws NotFoundException (404) when no matching record
   * exists or the record has been deleted.
   */
  async findByShortCode(short_code: string): Promise<urlsModel> {
    const url = await this.dbService.urls.findFirst({
      where: { short_code, deleted_at: null },
    });

    if (!url) {
      throw new NotFoundException(
        `No URL found for short_code "${short_code}"`,
      );
    }

    if (this.isExpired(url.expiry_date)) {
      throw new GoneException('This URL has expired');
    }

    const updatedUrl = await this.dbService.urls.update({
      where: { id: url.id },
      data: {
        visit_count: {
          increment: 1,
        },
        last_accessed_at: new Date(),
      },
    });

    return updatedUrl;
  }

  async deleteByShortCode({
    short_code,
    userId,
  }: {
    short_code: string;
    userId: number;
  }): Promise<void> {
    const url = await this.dbService.urls.findFirst({
      where: { short_code, deleted_at: null },
    });

    if (!url) {
      throw new NotFoundException(
        `No URL found for short_code "${short_code}"`,
      );
    }

    if (url.user_id !== userId) {
      throw new ForbiddenException('You are not allowed to delete this URL');
    }

    try {
      await this.dbService.urls.update({
        where: { id: url.id },
        data: { deleted_at: true },
      });
    } catch (error) {
      if (this.isRecordNotFoundError(error)) {
        throw new NotFoundException(
          `No URL found for short_code "${short_code}"`,
        );
      }
      throw error;
    }
  }

  async updateShortCode({
    short_code,
    new_short_code,
    userId,
  }: {
    short_code: string;
    new_short_code: string;
    userId: number;
  }): Promise<urlsModel> {
    const url = await this.dbService.urls.findFirst({
      where: { short_code, deleted_at: null },
    });

    if (!url) {
      throw new NotFoundException(
        `No URL found for short_code "${short_code}"`,
      );
    }

    if (url.user_id !== userId) {
      throw new ForbiddenException('You are not allowed to update this URL');
    }

    if (url.short_code === new_short_code) {
      return url;
    }

    try {
      return await this.dbService.urls.update({
        where: { id: url.id },
        data: { short_code: new_short_code, updated_at: new Date() },
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        throw new ConflictException(
          `custom_code "${new_short_code}" is already taken`,
        );
      }
      if (this.isRecordNotFoundError(error)) {
        throw new NotFoundException(
          `No URL found for short_code "${short_code}"`,
        );
      }
      throw error;
    }
  }

  /**
   * expiry_date is a DATE column, so the URL stays valid through the
   * whole expiry day and only expires once that day is over (local time).
   */
  private isExpired(expiry_date?: Date | string | null): boolean {
    if (!expiry_date) {
      return false;
    }

    const expiry =
      typeof expiry_date === 'string' ? new Date(expiry_date) : expiry_date;

    if (Number.isNaN(expiry.getTime())) {
      return false;
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    return expiry < startOfToday;
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    // Prisma throws PrismaClientKnownRequestError with code 'P2002'
    // for unique constraint violations. Checked structurally here to
    // avoid importing Prisma's runtime error classes directly.
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  private isRecordNotFoundError(error: unknown): boolean {
    // Prisma throws PrismaClientKnownRequestError with code 'P2025'
    // when delete()/update() targets a record that doesn't exist.
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2025'
    );
  }
}
