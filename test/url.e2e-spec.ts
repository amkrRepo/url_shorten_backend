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
    // This assumes the test database schema has already been migrated
    // against DATABASE_URL from .env.test, e.g. via:
    //   dotenv -e .env.test -- prisma migrate deploy
    // (wired up as the `pretest:e2e` npm script, run automatically
    // before `npm run test:e2e`).
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

  it('returns the same short_code for two shorten requests with the same original_url', async () => {
    const originalUrl = 'https://example.com/same-page';

    const firstResponse = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({ original_url: originalUrl });

    const secondResponse = await request(app.getHttpServer())
      .post('/urls/shorten')
      .send({ original_url: originalUrl });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstResponse.body.short_code).toBe(secondResponse.body.short_code);
    expect(secondResponse.body.id).toBe(firstResponse.body.id);
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

  it('returns the same short_code for two concurrent requests with the same original_url (race condition)', async () => {
    // This is the only test that actually exercises the P2002-on-
    // original_url catch block in UrlsService — the sequential
    // dedup test above never triggers that race path, since the
    // first request always fully completes before the second starts.
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
    expect(secondResponse.body.short_code).toBe(firstResponse.body.short_code);
    expect(secondResponse.body.id).toBe(firstResponse.body.id);

    // And only one row should actually exist in the database.
    const allMatching = await prisma.urls.findMany({
      where: { original_url: originalUrl },
    });
    expect(allMatching).toHaveLength(1);
  });
});
