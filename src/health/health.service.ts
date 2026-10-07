import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  timestamp: string;
  checks: {
    server: CheckStatus;
    database: CheckStatus;
  };
}

@Injectable()
export class HealthService {
  constructor(private readonly dbService: DbService) {}

  async check(): Promise<HealthReport> {
    const database = await this.pingDatabase();

    return {
      status: database === 'up' ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks: {
        server: 'up',
        database,
      },
    };
  }

  private async pingDatabase(): Promise<CheckStatus> {
    try {
      await this.dbService.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }
}
