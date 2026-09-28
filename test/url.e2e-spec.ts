import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import {
  describe,
  beforeAll,
  afterEach,
  it,
  expect,
  afterAll,
} from '@jest/globals';

describe('URLs E2E', () => {
  let app: INestApplication;
  let prisma: DbService;

  beforeAll(async () => {
    // The suite runs against the local test database from .env.test
    // (url_shortener_test), never against Neon. `pretest:e2e` applies
    // migrations to that local DB before every run:
    //   dotenv -e .env.test -- prisma migrate deploy
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror the global pipe registered in main.ts so validation
    // behaves identically to the real running app.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = moduleFixture.get<DbService>(DbService);
  });

  afterEach(async () => {
    // Isolation strategy: wipe the Url table after every test so each
    // test starts from a clean slate. This is the chosen approach
    // (rather than resetting the SQLite file between runs) since it's
    // fast and doesn't require respawning the Prisma client.
    await prisma.urls.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('shortens a URL and then redirects to the original URL (happy path)', async () => {
    // Arrange
    const originalUrl = 'https://example.com';

    // Act: create the short URL
    const createResponse = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({ original_url: originalUrl });

    // Assert: creation succeeded and returned a short_code
    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toHaveProperty('id');
    expect(createResponse.body).toHaveProperty('short_code');
    expect(createResponse.body.original_url).toBe(originalUrl);

    const { short_code } = createResponse.body;

    // Act: follow the short_code via the redirect endpoint
    const redirectResponse = await request(app.getHttpServer()).get(
      `/urls/redirect?short_code=${short_code}`,
    );

    // Assert: a real 302 redirect pointing at the original URL
    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers['location']).toBe(originalUrl);
  });

  it('returns 400 when original_url is missing from the request body', async () => {
    const response = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({});

    expect(response.status).toBe(400);
  });

  it('returns 400 when original_url is not a syntactically valid URL', async () => {
    const response = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({ original_url: 'not-a-url' });

    expect(response.status).toBe(400);
  });

  it('returns 404 when redirecting with a short_code that does not exist', async () => {
    const response = await request(app.getHttpServer()).get(
      '/urls/redirect?short_code=doesnotexist',
    );

    expect(response.status).toBe(404);
  });

  it('creates a new short_code for each shorten request with the same original_url', async () => {
    const originalUrl = 'https://example.com/same-page';

    const firstResponse = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({ original_url: originalUrl });

    const secondResponse = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({ original_url: originalUrl });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body.short_code).not.toBe(
      firstResponse.body.short_code,
    );
    expect(secondResponse.body.id).not.toBe(firstResponse.body.id);

    // Both rows are persisted, one per request.
    const allMatching = await prisma.urls.findMany({
      where: { original_url: originalUrl },
    });
    expect(allMatching).toHaveLength(2);
  });

  it('returns 400 when the short_code query parameter is missing entirely', async () => {
    const response = await request(app.getHttpServer()).get('/urls/redirect');
    expect(response.status).toBe(400);
  });

  it('returns 400 when the short_code query parameter is an empty string', async () => {
    const response = await request(app.getHttpServer()).get(
      '/urls/redirect?short_code=',
    );
    expect(response.status).toBe(400);
  });

  it('creates distinct short_codes for two concurrent requests with the same original_url', async () => {
    // Both inserts race with no original_url constraint to serialize them,
    // so each must land as its own row with its own short_code. The retry
    // loop in UrlsService only guards against short_code collisions.
    const originalUrl = `https://example.com/race-test-${Date.now()}`;

    const [firstResponse, secondResponse] = await Promise.all([
      request(app.getHttpServer())
        .post('/urls/shorten')
        .send({ original_url: originalUrl }),
      request(app.getHttpServer())
        .post('/urls/shorten')
        .send({ original_url: originalUrl }),
    ]);

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body.short_code).not.toBe(
      firstResponse.body.short_code,
    );
    expect(secondResponse.body.id).not.toBe(firstResponse.body.id);

    // Two rows should exist in the database, one per request.
    const allMatching = await prisma.urls.findMany({
      where: { original_url: originalUrl },
    });
    expect(allMatching).toHaveLength(2);
  });
});
