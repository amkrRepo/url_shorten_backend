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

  const shorten = (
    original_url: string,
    apiKey?: string,
    options: { expiry_date?: string; custom_code?: string } = {},
  ) => {
    const req = request(app.getHttpServer())
      .post('/urls/shorten')
      .set('Content-Type', 'application/json');
    if (apiKey) {
      req.set('x-api-key', apiKey);
    }
    return req.send({ original_url, ...options });
  };

  const updateShortCode = (
    shortCode: string,
    apiKey: string,
    newShortCode: string,
    options: { password?: string; clearPassword?: boolean } = {},
  ) => {
    const req = request(app.getHttpServer())
      .patch(`/urls/update?short_code=${encodeURIComponent(shortCode)}`)
      .set('Content-Type', 'application/json');

    if (apiKey) {
      req.set('x-api-key', apiKey);
    }

    return req.send({ new_short_code: newShortCode, ...options });
  };

  // Sends the payload as-is so tests can also cover malformed bodies
  // (empty array, non-array, oversized batch, ...). Typed as `object`
  // because superagent's send() only accepts `string | object`.
  const shortenBatch = (payload: object, apiKey?: string) => {
    const req = request(app.getHttpServer())
      .post('/urls/shorten/batch')
      .set('Content-Type', 'application/json');
    if (apiKey) {
      req.set('x-api-key', apiKey);
    }
    return req.send(payload);
  };

  interface BatchBody {
    total: number;
    successful: (ShortenBody & { index: number })[];
    failed: { index: number; original_url: string; message: string }[];
  }

  const batchBody = (response: request.Response): BatchBody =>
    response.body as BatchBody;

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
    // KEY_A is enterprise: /urls/shorten/batch is gated by TierGuard, so the
    // happy-path batch cases need an enterprise caller. KEY_B stays free.
    await prisma.users.upsert({
      where: { email: 'user1@example.com' },
      update: { api_key: KEY_A, tier: 'enterprise' },
      create: {
        email: 'user1@example.com',
        name: 'User 1',
        api_key: KEY_A,
        tier: 'enterprise',
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

  it('shortens a URL and then redirects to the original URL', async () => {
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

  it('returns 400 when original_url is not a valid URL', async () => {
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

  it('returns 401 when shortening with wrong API key', async () => {
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

  it('returns 410 when creating a url with an expiry_date in the past', async () => {
    const createResponse = await shorten('https://example.com', KEY_A, {
      expiry_date: '2026-09-30',
    });
    expect(createResponse.status).toBe(410);
  });

  it('returns 410 when fetching an expired url', async () => {
    // Seeded through Prisma because creation rejects past expiry dates,
    // so an expired row can only exist by bypassing the API.
    const expired = await prisma.urls.create({
      data: {
        original_url: 'https://example.com/expired',
        short_code: 'expired-code',
        expiry_date: new Date('2026-09-30'),
      },
    });

    const detailsResponse = await request(app.getHttpServer()).get(
      `/urls/details?short_code=${expired.short_code}`,
    );
    expect(detailsResponse.status).toBe(410);

    const redirectResponse = await request(app.getHttpServer()).get(
      `/urls/redirect?short_code=${expired.short_code}`,
    );
    expect(redirectResponse.status).toBe(410);
  });

  it('creates a url with the custom code requested by the user', async () => {
    const createResponse = await shorten('https://example.com', KEY_A, {
      custom_code: 'awesome-article',
    });
    expect(createResponse.status).toBe(201);
    const created = shortenBody(createResponse);
    expect(created.short_code).toBe('awesome-article');
    expect(created.original_url).toBe('https://example.com');

    // The requested code is usable immediately, just like a generated one.
    const redirectResponse = await request(app.getHttpServer()).get(
      '/urls/redirect?short_code=awesome-article',
    );
    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers['location']).toBe('https://example.com');
  });

  it('returns 409 when the requested custom code is already taken', async () => {
    const first = await shorten('https://example.com', KEY_A, {
      custom_code: 'taken-code',
    });
    expect(first.status).toBe(201);

    const second = await shorten('https://other.example.com', KEY_A, {
      custom_code: 'taken-code',
    });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe('Conflict');

    // The first url keeps the code and its original target.
    const detailsResponse = await request(app.getHttpServer()).get(
      '/urls/details?short_code=taken-code',
    );
    expect(detailsResponse.status).toBe(202);
    expect(
      (detailsResponse.body as { original_url: string }).original_url,
    ).toBe('https://example.com');
  });

  it('shortens every url of a batch when all entries are valid', async () => {
    const response = await shortenBatch(
      {
        urls: [
          'https://example.com/a',
          'https://example.com/a',
          'https://example.com/b',
        ],
      },
      KEY_A,
    );

    expect(response.status).toBe(207);
    const batch = batchBody(response);
    expect(batch.total).toBe(3);
    expect(batch.successful).toHaveLength(3);
    expect(batch.failed).toHaveLength(0);
    expect(batch.successful.map((entry) => entry.index)).toEqual([0, 1, 2]);

    // Duplicate entries each get their own short_code and row.
    expect(batch.successful[0].short_code).not.toBe(
      batch.successful[1].short_code,
    );
    expect(await prisma.urls.count()).toBe(3);

    // Codes returned by the batch behave like any other short code.
    const redirectResponse = await request(app.getHttpServer()).get(
      `/urls/redirect?short_code=${batch.successful[0].short_code}`,
    );
    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers['location']).toBe('https://example.com/a');
  });

  it('returns partial success when some entries of the batch fail', async () => {
    const response = await shortenBatch(
      {
        urls: [
          'https://example.com/good-1',
          'not-a-url',
          'https://example.com/good-2',
        ],
      },
      KEY_A,
    );

    expect(response.status).toBe(207);
    const batch = batchBody(response);
    expect(batch.total).toBe(3);
    expect(batch.successful.map((entry) => entry.index)).toEqual([0, 2]);
    expect(batch.failed).toHaveLength(1);
    expect(batch.failed[0]).toEqual({
      index: 1,
      original_url: 'not-a-url',
      message: 'original_url is not a valid URL',
    });

    // Only the valid entries were persisted.
    expect(await prisma.urls.count()).toBe(2);
    const persisted = await prisma.urls.findMany({
      where: { original_url: { startsWith: 'https://example.com/good-' } },
      orderBy: { original_url: 'asc' },
    });
    expect(persisted.map((url) => url.original_url)).toEqual([
      'https://example.com/good-1',
      'https://example.com/good-2',
    ]);
  });

  it('reports every entry as failed when no url in the batch is valid', async () => {
    const response = await shortenBatch(
      { urls: ['not-a-url', 'also not a url'] },
      KEY_A,
    );

    expect(response.status).toBe(207);
    const batch = batchBody(response);
    expect(batch.total).toBe(2);
    expect(batch.successful).toHaveLength(0);
    expect(batch.failed.map((entry) => entry.index)).toEqual([0, 1]);
    expect(await prisma.urls.count()).toBe(0);
  });

  it('returns 403 when a free tier user calls the batch endpoint', async () => {
    const response = await shortenBatch(
      { urls: ['https://example.com'] },
      KEY_B,
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ message: 'Upgrade to enterprise' });
    expect(await prisma.urls.count()).toBe(0);
  });

  it('returns 401 when batching without an API key', async () => {
    const response = await shortenBatch({ urls: ['https://example.com'] });
    expect(response.status).toBe(401);
  });

  // Tests for update short_code

  it('returns 200 when updated url short_code', async () => {
    const createdResponse = await shorten('https://example.com', KEY_A);
    const { short_code } = shortenBody(createdResponse);

    const updatedShortCode = await updateShortCode(
      short_code,
      KEY_A,
      'new_code_123',
    );

    expect(updatedShortCode.status).toBe(200);
    expect(shortenBody(updatedShortCode).short_code).toBe('new_code_123');
  });

  it('returns 400 when new_short_code is empty string', async () => {
    const createdResponse = await shorten('https://example.com', KEY_A);
    const { short_code } = shortenBody(createdResponse);

    const updatedShortCode = await updateShortCode(short_code, KEY_A, '');

    expect(updatedShortCode.status).toBe(400);
  });

  it('returns 403 when updating a URL that belongs to another user', async () => {
    const createdResponse = await shorten('https://example.com', KEY_A);
    expect(createdResponse.status).toBe(201);
    const { short_code } = shortenBody(createdResponse);

    const response = await updateShortCode(short_code, KEY_B, 'hijacked_code');

    expect(response.status).toBe(403);

    // The URL must keep its original short_code and still be live after
    // the rejected attempt.
    const redirectResponse = await request(app.getHttpServer()).get(
      `/urls/redirect?short_code=${short_code}`,
    );
    // means: the original short_code still exists in the DB and still points at https://example.com.
    expect(redirectResponse.status).toBe(302);

    const detailsResponse = await request(app.getHttpServer()).get(
      `/urls/details?short_code=${short_code}`,
    );
    // returns 202 with the row's data when the code exists and isn't deleted/short-circuited.
    expect(detailsResponse.status).toBe(202);
    const hijackRedirect = await request(app.getHttpServer()).get(
      '/urls/redirect?short_code=hijacked_code',
    );
    // If the hijack had (wrongly) worked, the row's short_code would now be hijacked_code,
    // this lookup would find nothing, and you'd get a 404 instead.
    expect(hijackRedirect.status).toBe(404);
  });

  it('returns 404 when short_code that is used for update does not exist', async () => {
    const updatedShortCode = await updateShortCode(
      'doesNotExist',
      KEY_A,
      'updated_code',
    );
    expect(updatedShortCode.status).toBe(404);
  });
});
