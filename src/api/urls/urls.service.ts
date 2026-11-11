import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { isURL } from 'class-validator';
import { DbService } from '../../db/db.service';
import { Prisma } from '../../../generated/prisma/client';
import type { UrlDetailsDto } from './dto/urls.dto';
import type { urlsModel } from 'generated/prisma/models/urls';
import { generateShortCode } from '../../common/short-code-utils';
import { hashPassword, verifyPassword } from '../../common/password-utils';

const MAX_GENERATION_ATTEMPTS = 5;

// Visit buffer: written to the DB every interval, or sooner once this many
// distinct short_codes are waiting.
const VISIT_FLUSH_INTERVAL_MS = 10000;
const VISIT_FLUSH_MAX_CODES = 500;

interface PendingVisits {
  count: number;
  lastAccessedAt: Date;
}

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

// Password field is removed from urlsModel
export type PublicUrl = Omit<urlsModel, 'password'> & {
  has_password: boolean;
};

@Injectable()
export class UrlsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UrlsService.name);

  /**
   * short_code -> original_url for links already resolved through
   * `resolveRedirectUrl`, so repeat redirects skip the SELECT. The service
   * is a singleton, so v1 and v2 share this one cache. Only links with no
   * password and no expiry are stored, because a hit skips both checks.
   */
  private readonly redirectCache = new Map<string, string>();

  /** short_code -> visits not yet written to the DB. */
  private visitBuffer = new Map<string, PendingVisits>();
  private flushTimer?: NodeJS.Timeout;
  private inFlightFlush: Promise<void> | null = null;
  /**
   * Set while the DB is rejecting flushes, so a full buffer doesn't fire
   * a new flush on every visit; the interval keeps retrying instead.
   */
  private lastFlushFailed = false;

  constructor(private readonly dbService: DbService) {}

  onModuleInit() {
    this.flushTimer = setInterval(() => {
      void this.flushVisits();
    }, VISIT_FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for the flush timer.
    this.flushTimer.unref();
  }

  /**
   * Graceful shutdown (needs `app.enableShutdownHooks()`). DbModule is
   * global, so Nest destroys it after this module and the connection is
   * still open here.
   */
  async onModuleDestroy() {
    clearInterval(this.flushTimer);

    await this.inFlightFlush;
    await this.flushVisits();

    if (this.visitBuffer.size > 0) {
      this.logger.error(
        `Shutting down with ${this.visitBuffer.size} short_code(s) of unflushed visits`,
      );
    }
  }

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

  /**
   * Lists every live (not soft-deleted) URL owned by `userId`, newest
   * first. Expired rows are included so the owner can still see and
   * clean them up.
   */
  async listUserUrls(userId: number): Promise<PublicUrl[]> {
    const urls = await this.dbService.urls.findMany({
      where: { user_id: userId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });

    return urls.map(({ password: storedPassword, ...url }) => ({
      ...url,
      has_password: storedPassword !== null,
    }));
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
   * the visit in the buffer, so the returned row's visit_count and
   * last_accessed_at don't include this visit yet. Throws
   * NotFoundException (404) when no matching record
   * exists or the record has been deleted, and ForbiddenException (403)
   * when the record is password protected and `password` does not match.
   */
  async findByShortCode(
    short_code: string,
    password?: string,
  ): Promise<urlsModel> {
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

    // Verified before the visit is recorded so a rejected attempt never
    // counts as a visit.
    await this.assertPasswordMatches(url, password);

    this.recordVisit(short_code);

    return url;
  }

  /**
   * Returns the original_url to redirect to and records the visit. A
   * cache hit needs no DB work at all; a miss goes through
   * `findByShortCode` (existence, expiry and password checks) and caches
   * the result when the link has no password and no expiry.
   */
  async resolveRedirectUrl(
    short_code: string,
    password?: string,
  ): Promise<string> {
    const cached = this.redirectCache.get(short_code);
    if (cached) {
      this.recordVisit(short_code);
      return cached;
    }

    const url = await this.findByShortCode(short_code, password);

    if (!url.password && !url.expiry_date) {
      this.redirectCache.set(short_code, url.original_url);
    }

    return url.original_url;
  }

  /**
   * Counts a visit in memory; no DB work happens here. Visits reach the
   * DB on the next flush (every VISIT_FLUSH_INTERVAL_MS, or as soon as
   * VISIT_FLUSH_MAX_CODES distinct short_codes are waiting).
   */
  private recordVisit(short_code: string): void {
    this.addVisits(short_code, 1, new Date());

    if (
      this.visitBuffer.size >= VISIT_FLUSH_MAX_CODES &&
      !this.inFlightFlush &&
      !this.lastFlushFailed
    ) {
      void this.flushVisits();
    }
  }

  private addVisits(short_code: string, count: number, at: Date): void {
    const pending = this.visitBuffer.get(short_code);

    if (!pending) {
      this.visitBuffer.set(short_code, { count, lastAccessedAt: at });
      return;
    }

    pending.count += count;
    if (at > pending.lastAccessedAt) {
      pending.lastAccessedAt = at;
    }
  }

  /**
   * Writes every buffered visit with a single UPDATE. Concurrent callers
   * share the flush already running. On failure the batch is merged back
   * into the buffer, so the next interval retries it along with any visits
   * recorded in the meantime.
   */
  flushVisits(): Promise<void> {
    if (this.inFlightFlush) {
      return this.inFlightFlush;
    }
    if (this.visitBuffer.size === 0) {
      return Promise.resolve();
    }

    // Swap first so visits recorded during the write go into a new buffer.
    const batch = this.visitBuffer;
    this.visitBuffer = new Map();

    this.inFlightFlush = this.writeVisits(batch)
      .then(() => {
        this.lastFlushFailed = false;
      })
      .catch((error: unknown) => {
        this.lastFlushFailed = true;
        for (const [code, { count, lastAccessedAt }] of batch) {
          this.addVisits(code, count, lastAccessedAt);
        }
        this.logger.error(
          `Visit flush failed for ${batch.size} short_code(s); will retry`,
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.inFlightFlush = null;
      });

    return this.inFlightFlush;
  }

  private async writeVisits(batch: Map<string, PendingVisits>): Promise<void> {
    // Timestamps go in as UTC ISO strings and are converted to UTC wall
    // time, matching how Prisma stores this `timestamp` column.
    const rows = Prisma.join(
      [...batch].map(
        ([code, { count, lastAccessedAt }]) =>
          Prisma.sql`(${code}::varchar, ${count}::int, (${lastAccessedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`,
      ),
    );

    // GREATEST ignores NULLs and keeps a retried (older) batch from moving
    // last_accessed_at backwards.
    await this.dbService.$executeRaw`
      UPDATE urls AS u
      SET visit_count = u.visit_count + v.visits,
          last_accessed_at = GREATEST(u.last_accessed_at, v.last_accessed_at)
      FROM (VALUES ${rows}) AS v(short_code, visits, last_accessed_at)
      WHERE u.short_code = v.short_code
        AND u.deleted_at IS NULL
    `;
  }

  /**
   * Rejects access to a password-protected short_code when no password is
   * supplied or when it does not match the stored hash. Rows without a
   * password are always allowed.
   */
  private async assertPasswordMatches(
    url: Pick<urlsModel, 'short_code' | 'password'>,
    password?: string,
  ): Promise<void> {
    if (!url.password) {
      return;
    }

    if (!password) {
      throw new ForbiddenException(
        `short_code "${url.short_code}" is password protected`,
      );
    }

    const matches = await verifyPassword(password, url.password);
    if (!matches) {
      throw new ForbiddenException('Incorrect password');
    }
  }

  async deleteByShortCode({
    short_code,
    userId,
    password,
  }: {
    short_code: string;
    userId: number;
    password?: string;
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

    await this.assertPasswordMatches(url, password);

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

    this.redirectCache.delete(short_code);
  }

  async updateShortCode({
    short_code,
    new_short_code,
    userId,
    password,
    clearPassword,
  }: {
    short_code: string;
    new_short_code: string;
    userId: number;
    password?: string;
    clearPassword?: boolean;
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

    if (password && clearPassword) {
      throw new BadRequestException(
        'password and clearPassword cannot be used together',
      );
    }

    const changesCode = url.short_code !== new_short_code;
    const changesPassword = Boolean(password) || clearPassword === true;

    if (!changesCode && !changesPassword) {
      return url;
    }

    const data: {
      short_code?: string;
      password?: string | null;
      updated_at: Date;
    } = { updated_at: new Date() };

    if (changesCode) {
      data.short_code = new_short_code;
    }

    if (clearPassword) {
      data.password = null;
    } else if (password) {
      data.password = await hashPassword(password);
    }

    try {
      const updated = await this.dbService.urls.update({
        where: { id: url.id },
        data,
      });

      // The old code may now be renamed or newly password protected.
      this.redirectCache.delete(short_code);

      return updated;
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
