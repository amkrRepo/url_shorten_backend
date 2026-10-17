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
  private lastModified = 0;

  isBlocked(apiKey: string): boolean {
    this.reloadIfChanged();
    return this.blockedKeys.has(apiKey);
  }

  private reloadIfChanged() {
    try {
      const mtime = statSync(this.filePath).mtimeMs;
      if (mtime === this.lastModified) return; // file unchanged, use cache

      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      this.blockedKeys = new Set(data.blockedKeys ?? []);
      this.lastModified = mtime;
      this.logger.log(`Blacklist reloaded: ${this.blockedKeys.size} keys`);
    } catch (err) {
      // missing or invalid file: keep the last known list instead of crashing
      this.logger.error(`Could not load blacklist: ${(err as Error).message}`);
    }
  }
}
