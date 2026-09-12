import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { describe, beforeAll, afterEach, it, expect } from '@jest/globals';

describe('Url Shortner E2E', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /urls/shorten', () => {
    it('creates a short code for a valid url', async () => {
      const res = await request(app.getHttpServer())
        .post('/urls/shorten')
        .send({ original_url: 'https://example.com/some/very/long/path' });

      expect(res.status).toBe(201);
      expect(res.body.original_url).toBe(
        'https://example.com/some/very/long/path',
      );
      expect(res.body.short_code).toHaveLength(8);
    });

    it('rejects an invalid url with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/urls/shorten')
        .send({ original_url: 'not-a-url' });

      expect(res.status).toBe(400);
    });

    it('rejects a request with no url with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/urls/shorten')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /urls/details', () => {
    it('returns url details for a known code', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/urls/shorten')
        .send({ original_url: 'https://nestjs.com/docs' });

      const { short_code } = createRes.body;

      const res = await request(app.getHttpServer()).get(
        `/urls/details?short_code=${short_code}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.original_url).toBe('https://nestjs.com/docs');
    });

    it('returns 400 for an unknown code', async () => {
      const res = await request(app.getHttpServer()).get(
        '/urls/details?short_code=doesnotexist',
      );
      expect(res.status).toBe(400);
    });
  });
});
