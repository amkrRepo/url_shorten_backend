import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { UrlDetailsDto } from './dto/urls.dto';
import type { urlsModel } from 'generated/prisma/models/urls';
import { generateShortCode } from '../../common/short-code-utils';

const MAX_GENERATION_ATTEMPTS = 5;
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

    return urlDetails;
  }

  async createShortUrl(
    dto: UrlDetailsDto,
    userId?: number,
  ): Promise<urlsModel> {
    // Every request creates a fresh row with its own short_code, even
    // when the original_url has been shortened before. The only unique
    // constraint is short_code, so the only failure worth retrying is a
    // generated-code collision.
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const short_code = generateShortCode();
      try {
        return await this.dbService.urls.create({
          data: {
            original_url: dto.original_url,
            short_code,
            user_id: userId ?? null,
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
