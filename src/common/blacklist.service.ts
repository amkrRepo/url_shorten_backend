import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);
  private readonly filePath =
    process.env.BLACKLIST_FILE ??
    join(process.cwd(), 'config', 'blacklist.json');

  private blockedKeys = new Set<string>();
  private lastMtimeMs = -1;
  private missingLogged = false;

  isBlocked(apiKey: string): boolean {
    this.refreshIfChanged();

    return this.blockedKeys.has(apiKey);
  }

  private refreshIfChanged(): void {
    let mtimeMs: number;

    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch (err) {
      // Log once per outage, not on every request, and keep the last list.
      if (!this.missingLogged) {
        this.logger.error(
          `Cannot read blacklist file ${this.filePath}: ${(err as Error).message}`,
        );
        this.missingLogged = true;
      }

      return;
    }

    this.missingLogged = false;

    if (mtimeMs === this.lastMtimeMs) {
      return;
    }

    // Record the mtime even when parsing fails, so a broken file is
    // reported once instead of being re-parsed on every request.
    this.lastMtimeMs = mtimeMs;

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const keys = (parsed as { blockedKeys?: unknown })?.blockedKeys;

      if (
        !Array.isArray(keys) ||
        !keys.every((key) => typeof key === 'string')
      ) {
        throw new Error('"blockedKeys" must be an array of strings');
      }

      this.blockedKeys = new Set(keys as string[]);
    } catch (err) {
      this.logger.error(
        `Invalid blacklist file ${this.filePath}, keeping last known list: ${(err as Error).message}`,
      );
    }
  }
}
