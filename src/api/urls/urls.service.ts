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
import { RedisService } from '../../redis/redis.service';
import { Prisma } from '../../../generated/prisma/client';
import type { UrlDetailsDto } from './dto/urls.dto';
import type { urlsModel } from 'generated/prisma/models/urls';
import { generateShortCode } from '../../common/short-code-utils';
import { hashPassword, verifyPassword } from '../../common/password-utils';

const MAX_GENERATION_ATTEMPTS = 5;

const VISIT_FLUSH_INTERVAL_MS = 10000;
const VISIT_FLUSH_MAX_CODES = 500;

const REDIRECT_CACHE_PREFIX = 'redirect:';
const REDIRECT_CACHE_MAX_TTL_MS =
  Number(process.env.REDIRECT_CACHE_TTL_SECONDS ?? 86400) * 1000;

interface PendingVisits {
  count: number;
  lastAccessedAt: Date;
}

interface CachedRedirect {
  originalUrl: string;
  browserCacheable: boolean;
}

export interface RedirectResolution {
  originalUrl: string;
  cacheHit: boolean;
  browserCacheable: boolean;
}

export interface RedirectCacheStats {
  enabled: boolean;
  hits: number;
  misses: number;
  hitRatio: number;
  size: number;
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

  private readonly redirectCacheEnabled =
    process.env.REDIRECT_CACHE_ENABLED !== 'false';

  private cacheHits = 0;
  private cacheMisses = 0;

  /** short_code -> visits not yet written to the DB. */
  private visitBuffer = new Map<string, PendingVisits>();
  private flushTimer?: NodeJS.Timeout;
  private inFlightFlush: Promise<void> | null = null;
  private lastFlushFailed = false;

  constructor(
    private readonly dbService: DbService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    this.flushTimer = setInterval(() => {
      void this.flushVisits();
    }, VISIT_FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for the flush timer.
    this.flushTimer.unref();
  }

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

    return this.createGeneratedUrl(dto.original_url, userId, expiry_date);
  }

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

    await this.assertPasswordMatches(url, password);

    this.recordVisit(short_code);

    return url;
  }

  async resolveRedirectUrl(
    short_code: string,
    password?: string,
  ): Promise<RedirectResolution> {
    if (this.redirectCacheEnabled) {
      const cached = await this.readCachedRedirect(short_code);
      if (cached) {
        this.cacheHits++;
        this.recordVisit(short_code);
        return { ...cached, cacheHit: true };
      }
    }

    this.cacheMisses++;
    const url = await this.findByShortCode(short_code, password);

    const browserCacheable = !url.password && !url.expiry_date;

    if (this.redirectCacheEnabled && !url.password) {
      await this.writeCachedRedirect(
        short_code,
        { originalUrl: url.original_url, browserCacheable },
        url.expiry_date,
      );
    }

    return {
      originalUrl: url.original_url,
      cacheHit: false,
      browserCacheable,
    };
  }

  async getRedirectCacheStats(): Promise<RedirectCacheStats> {
    const total = this.cacheHits + this.cacheMisses;
    return {
      enabled: this.redirectCacheEnabled,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRatio: total === 0 ? 0 : this.cacheHits / total,
      size: (await this.scanRedirectCacheKeys()).length,
    };
  }

  async resetRedirectCacheStats(): Promise<void> {
    this.cacheHits = 0;
    this.cacheMisses = 0;

    const keys = await this.scanRedirectCacheKeys();
    if (keys.length > 0) {
      await this.redis.unlink(...keys);
    }
  }

  private async readCachedRedirect(
    short_code: string,
  ): Promise<CachedRedirect | null> {
    try {
      const raw = await this.redis.get(REDIRECT_CACHE_PREFIX + short_code);
      return raw ? (JSON.parse(raw) as CachedRedirect) : null;
    } catch (error) {
      this.logger.warn(
        `Redirect cache read failed for "${short_code}": ${this.errorMessage(error)}`,
      );
      return null;
    }
  }

  private async writeCachedRedirect(
    short_code: string,
    entry: CachedRedirect,
    expiry_date: Date | string | null,
  ): Promise<void> {
    const expiresAt = this.expiresAt(expiry_date);
    const ttlMs = Math.min(
      REDIRECT_CACHE_MAX_TTL_MS,
      expiresAt === null ? Infinity : expiresAt.getTime() - Date.now(),
    );

    if (ttlMs <= 0) {
      return;
    }

    try {
      await this.redis.set(
        REDIRECT_CACHE_PREFIX + short_code,
        JSON.stringify(entry),
        'PX',
        ttlMs,
      );
    } catch (error) {
      this.logger.warn(
        `Redirect cache write failed for "${short_code}": ${this.errorMessage(error)}`,
      );
    }
  }

  private async invalidateCachedRedirect(short_code: string): Promise<void> {
    try {
      await this.redis.del(REDIRECT_CACHE_PREFIX + short_code);
    } catch (error) {
      this.logger.error(
        `Could not invalidate cached redirect for "${short_code}"; it may be served until its TTL ends`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async scanRedirectCacheKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${REDIRECT_CACHE_PREFIX}*`,
        'COUNT',
        1000,
      );
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }

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

  flushVisits(): Promise<void> {
    if (this.inFlightFlush) {
      return this.inFlightFlush;
    }
    if (this.visitBuffer.size === 0) {
      return Promise.resolve();
    }

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
    const rows = Prisma.join(
      [...batch].map(
        ([code, { count, lastAccessedAt }]) =>
          Prisma.sql`(${code}::varchar, ${count}::int, (${lastAccessedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`,
      ),
    );

    await this.dbService.$executeRaw`
      UPDATE urls AS u
      SET visit_count = u.visit_count + v.visits,
          last_accessed_at = GREATEST(u.last_accessed_at, v.last_accessed_at)
      FROM (VALUES ${rows}) AS v(short_code, visits, last_accessed_at)
      WHERE u.short_code = v.short_code
        AND u.deleted_at IS NULL
    `;
  }

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

    await this.invalidateCachedRedirect(short_code);
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
      await this.invalidateCachedRedirect(short_code);

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

  private isExpired(expiry_date?: Date | string | null): boolean {
    const expiresAt = this.expiresAt(expiry_date);
    return expiresAt !== null && Date.now() >= expiresAt.getTime();
  }

  private expiresAt(expiry_date?: Date | string | null): Date | null {
    if (!expiry_date) {
      return null;
    }

    const expiry =
      typeof expiry_date === 'string' ? new Date(expiry_date) : expiry_date;

    if (Number.isNaN(expiry.getTime())) {
      return null;
    }

    const endOfExpiryDay = new Date(expiry);
    endOfExpiryDay.setHours(0, 0, 0, 0);
    endOfExpiryDay.setDate(endOfExpiryDay.getDate() + 1);
    return endOfExpiryDay;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  private isRecordNotFoundError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2025'
    );
  }
}
