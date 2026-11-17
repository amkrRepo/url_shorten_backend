import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { RATE_LIMIT_OPTIONS } from '../src/common/rate-limit.service';
import { describe, beforeEach, afterEach, it, expect } from '@jest/globals';

describe('Rate limiting (e2e)', () => {
  const LIMIT = 5;
  let app: INestApplication<App>;

  // A fresh app per test gives each test its own empty counter.
  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RATE_LIMIT_OPTIONS)
      .useValue({ limit: LIMIT, windowMs: 60_000 })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests up to the limit with rate-limit headers', async () => {
    for (let i = 1; i <= LIMIT; i++) {
      const res = await request(app.getHttpServer()).get('/').expect(200);
      expect(res.headers['x-ratelimit-limit']).toBe(String(LIMIT));
      expect(res.headers['x-ratelimit-remaining']).toBe(String(LIMIT - i));
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    }
  });

  it('returns 429 Too Many Requests with Retry-After once the limit is exceeded', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await request(app.getHttpServer()).get('/').expect(200);
    }

    const res = await request(app.getHttpServer()).get('/').expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.body).toMatchObject({ statusCode: 429 });
  });

  it('counts requests across all routes for the same IP', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await request(app.getHttpServer()).get('/');
    }

    // A different API route is also blocked: the limit is per client.
    await request(app.getHttpServer()).get('/api/v1/urls/list').expect(429);
  });

  it('does not rate-limit the health check', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await request(app.getHttpServer()).get('/');
    }
    await request(app.getHttpServer()).get('/').expect(429);

    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).not.toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
