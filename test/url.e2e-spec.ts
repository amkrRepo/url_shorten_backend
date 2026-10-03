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

  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);

  interface ShortenBody {
    id: number;
    short_code: string;
    original_url: string;
  }

  // supertest types `response.body` as any; narrow it so assertions stay
  // typed instead of tripping the no-unsafe-* lint rules.
  const shortenBody = (response: request.Response): ShortenBody =>
    response.body as ShortenBody;

  const shorten = (original_url: string, apiKey?: string) => {
    const req = request(app.getHttpServer())
      .post('/urls/shorten')
      .set('Content-Type', 'application/json');
    if (apiKey) {
      req.set('x-api-key', apiKey);
    }
    return req.send({ original_url });
  };

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

    // Two owners so tests can cover the 403 (wrong API key) path.
    await prisma.users.upsert({
      where: { email: 'user1@example.com' },
      update: { api_key: KEY_A },
      create: {
        email: 'user1@example.com',
        name: 'User 1',
        api_key: KEY_A,
      },
    });
    await prisma.users.upsert({
      where: { email: 'user2@example.com' },
      update: { api_key: KEY_B },
      create: {
        email: 'user2@example.com',
        name: 'User 2',
        api_key: KEY_B,
      },
    });
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
    const createResponse = await shorten(originalUrl, KEY_A);

    // Assert: creation succeeded and returned a short_code
    const created = shortenBody(createResponse);
    expect(createResponse.status).toBe(201);
    expect(created).toHaveProperty('id');
    expect(created).toHaveProperty('short_code');
    expect(created.original_url).toBe(originalUrl);

    const { short_code } = created;

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
      .set('x-api-key', KEY_A)
      .send({});

    expect(response.status).toBe(400);
  });

  it('returns 400 when original_url is not a syntactically valid URL', async () => {
    const response = await request(app.getHttpServer())
      .post('/urls/shorten')
      .set('x-api-key', KEY_A)
      .send({ original_url: 'not-a-url' });

    expect(response.status).toBe(400);
  });

  it('returns 401 when shortening without an API key', async () => {
    const response = await shorten('https://example.com');

    expect(response.status).toBe(401);
  });

  it('returns 401 when shortening with an unknown API key', async () => {
    const response = await shorten('https://example.com', 'not-a-real-key');

    expect(response.status).toBe(401);
  });

  it('returns 404 when redirecting with a short_code that does not exist', async () => {
    const response = await request(app.getHttpServer()).get(
      '/urls/redirect?short_code=doesnotexist',
    );

    expect(response.status).toBe(404);
  });

  it('creates a new short_code for each shorten request with the same original_url', async () => {
    const originalUrl = 'https://example.com/same-page';

    const firstResponse = await shorten(originalUrl, KEY_A);

    const secondResponse = await shorten(originalUrl, KEY_A);

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const first = shortenBody(firstResponse);
    const second = shortenBody(secondResponse);
    expect(second.short_code).not.toBe(first.short_code);
    expect(second.id).not.toBe(first.id);

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
      shorten(originalUrl, KEY_A),
      shorten(originalUrl, KEY_A),
    ]);

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const first = shortenBody(firstResponse);
    const second = shortenBody(secondResponse);
    expect(second.short_code).not.toBe(first.short_code);
    expect(second.id).not.toBe(first.id);

    // Two rows should exist in the database, one per request.
    const allMatching = await prisma.urls.findMany({
      where: { original_url: originalUrl },
    });
    expect(allMatching).toHaveLength(2);
  });

  it('returns 403 when deleting a URL that belongs to another user', async () => {
    const createResponse = await shorten('https://example.com', KEY_A);
    expect(createResponse.status).toBe(201);
    const { short_code } = shortenBody(createResponse);

    const response = await request(app.getHttpServer())
      .delete(`/urls/delete?short_code=${short_code}`)
      .set('x-api-key', KEY_B);

    expect(response.status).toBe(403);

    // The URL must still be live after the rejected attempt.
    const redirectResponse = await request(app.getHttpServer()).get(
      `/urls/redirect?short_code=${short_code}`,
    );
    expect(redirectResponse.status).toBe(302);
  });

  it('returns 404 when deleting a short_code that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .delete('/urls/delete?short_code=doesnotexist')
      .set('x-api-key', KEY_A);

    expect(response.status).toBe(404);
  });

  it('returns 204 for the owner delete and 404 when deleting it again', async () => {
    const createResponse = await shorten('https://example.com', KEY_A);
    expect(createResponse.status).toBe(201);
    const { short_code } = shortenBody(createResponse);

    const firstDelete = await request(app.getHttpServer())
      .delete(`/urls/delete?short_code=${short_code}`)
      .set('x-api-key', KEY_A);
    expect(firstDelete.status).toBe(204);

    const secondDelete = await request(app.getHttpServer())
      .delete(`/urls/delete?short_code=${short_code}`)
      .set('x-api-key', KEY_A);
    expect(secondDelete.status).toBe(404);
    expect((secondDelete.body as { error: string }).error).toBe('Not Found');
  });

  it('returns 404 when opening a short link after it was deleted', async () => {
    const createResponse = await shorten('https://example.com', KEY_A);
    expect(createResponse.status).toBe(201);
    const { short_code } = shortenBody(createResponse);

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/urls/delete?short_code=${short_code}`)
      .set('x-api-key', KEY_A);
    expect(deleteResponse.status).toBe(204);

    const redirectResponse = await request(app.getHttpServer()).get(
      `/urls/redirect?short_code=${short_code}`,
    );
    expect(redirectResponse.status).toBe(404);
  });

  it('returns 404 when asking for details of a deleted short_code', async () => {
    const createResponse = await shorten('https://example.com', KEY_A);
    expect(createResponse.status).toBe(201);
    const { short_code } = shortenBody(createResponse);

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/urls/delete?short_code=${short_code}`)
      .set('x-api-key', KEY_A);
    expect(deleteResponse.status).toBe(204);

    const detailsResponse = await request(app.getHttpServer()).get(
      `/urls/details?short_code=${short_code}`,
    );
    expect(detailsResponse.status).toBe(404);
  });
});
