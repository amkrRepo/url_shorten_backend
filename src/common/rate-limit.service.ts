import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

export interface RateLimitOptions {
  /** Max requests a single client may make inside one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');

export const rateLimitOptionsFromEnv = (): RateLimitOptions => ({
  limit: Number(process.env.RATE_LIMIT_MAX) || 100,
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
});

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the current window ends and the counter resets. */
  resetAt: number;
}

interface Window {
  count: number;
  start: number;
}

/**
 * Fixed-window rate limiter kept in memory.
 *
 * Each client key (the IP address) gets a counter and the time its window
 * started. When a request arrives after the window has ended, the counter
 * starts over. State lives in this process only, so with several app
 * instances each one enforces the limit separately.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly windows = new Map<string, Window>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    @Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions,
  ) {
    // Drop expired entries so clients that stop calling don't stay in memory.
    this.cleanupTimer = setInterval(() => this.cleanup(), options.windowMs);
    this.cleanupTimer.unref();
  }

  hit(key: string): RateLimitResult {
    const now = Date.now();
    const { limit, windowMs } = this.options;

    let window = this.windows.get(key);
    if (!window || now - window.start >= windowMs) {
      window = { count: 0, start: now };
      this.windows.set(key, window);
    }

    const resetAt = window.start + windowMs;

    if (window.count >= limit) {
      return { allowed: false, limit, remaining: 0, resetAt };
    }

    window.count++;
    return { allowed: true, limit, remaining: limit - window.count, resetAt };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.options.windowMs) {
        this.windows.delete(key);
      }
    }
  }

  /** Number of clients currently tracked (for tests). */
  get size() {
    return this.windows.size;
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }
}
