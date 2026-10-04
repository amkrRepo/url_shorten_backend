import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';

describe('User tier E2E', () => {
  let app: INestApplication;
  let prisma: DbService;

  const ENTERPRISE_KEY = 'e'.repeat(64);
  const FREE_KEY = 'f'.repeat(64);
  const ENTERPRISE_EMAIL = 'tier-ent@example.com';
  const FREE_EMAIL = 'tier-free@example.com';

  // supertest types `response.body` as any; narrow it so assertions stay
  // typed instead of tripping the no-unsafe-* lint rules.
  interface TierBody {
    tier?: string;
  }
  const tierBody = (response: request.Response): TierBody =>
    response.body as TierBody;

  // Owns the endpoint: no API key is needed to create a user.
  const createUser = (payload: object) =>
    request(app.getHttpServer())
      .post('/user/create')
      .set('Content-Type', 'application/json')
      .send(payload);

  const patchTier = (payload: object, apiKey?: string) => {
    const req = request(app.getHttpServer())
      .patch('/user/tier')
      .set('Content-Type', 'application/json');
    if (apiKey) {
      req.set('x-api-key', apiKey);
    }
    return req.send(payload);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Same options as main.ts so validation behaves identically.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = moduleFixture.get<DbService>(DbService);

    await prisma.users.deleteMany({
      where: { email: { in: [ENTERPRISE_EMAIL, FREE_EMAIL] } },
    });

    // The enterprise caller is seeded directly: PATCH /user/tier is the only
    // promotion path, so bootstrapping the first enterprise user has to
    // happen outside the API (same as the manual SQL step in dev).
    await prisma.users.create({
      data: {
        email: ENTERPRISE_EMAIL,
        name: 'Enterprise Caller',
        api_key: ENTERPRISE_KEY,
        tier: 'enterprise',
      },
    });
    await prisma.users.create({
      data: {
        email: FREE_EMAIL,
        name: 'Free Caller',
        api_key: FREE_KEY,
      },
    });
  });

  afterAll(async () => {
    await prisma.users.deleteMany({
      where: { email: { in: [ENTERPRISE_EMAIL, FREE_EMAIL] } },
    });
    await app.close();
  });

  describe('POST /user/create', () => {
    it('creates a user with the free tier by default', async () => {
      const response = await createUser({
        email: 'tier-created@example.com',
        name: 'Created',
        api_key: 'c'.repeat(64),
      });

      expect(response.status).toBe(201);
      expect(tierBody(response).tier).toBe('free');

      await prisma.users.deleteMany({
        where: { email: 'tier-created@example.com' },
      });
    });

    it('rejects a tier field in the create body', async () => {
      const response = await createUser({
        email: 'tier-smuggle@example.com',
        name: 'Smuggle',
        api_key: 's'.repeat(64),
        tier: 'enterprise',
      });

      expect(response.status).toBe(400);

      await prisma.users.deleteMany({
        where: { email: 'tier-smuggle@example.com' },
      });
    });
  });

  describe('PATCH /user/tier', () => {
    it('promotes a free user to enterprise when the caller is enterprise', async () => {
      const response = await patchTier(
        { email: FREE_EMAIL, tier: 'enterprise' },
        ENTERPRISE_KEY,
      );

      expect(response.status).toBe(200);
      expect(tierBody(response).tier).toBe('enterprise');

      // Restore so the other cases still see a free user.
      await prisma.users.update({
        where: { email: FREE_EMAIL },
        data: { tier: 'free' },
      });
    });

    it('is idempotent when the user is already enterprise', async () => {
      const response = await patchTier(
        { email: ENTERPRISE_EMAIL, tier: 'enterprise' },
        ENTERPRISE_KEY,
      );

      expect(response.status).toBe(200);
      expect(tierBody(response).tier).toBe('enterprise');
    });

    it('returns 403 when a free user tries to promote someone', async () => {
      const response = await patchTier(
        { email: ENTERPRISE_EMAIL, tier: 'enterprise' },
        FREE_KEY,
      );

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ message: 'Upgrade to enterprise' });
    });

    it('returns 401 without an api key', async () => {
      const response = await patchTier({
        email: FREE_EMAIL,
        tier: 'enterprise',
      });

      expect(response.status).toBe(401);
    });

    it('returns 400 when the requested tier is not an upgrade', async () => {
      const response = await patchTier(
        { email: FREE_EMAIL, tier: 'free' },
        ENTERPRISE_KEY,
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        message: 'Only free to enterprise upgrades are supported',
      });
    });

    it('returns 400 for a tier value outside the allowed set', async () => {
      const response = await patchTier(
        { email: FREE_EMAIL, tier: 'pro' },
        ENTERPRISE_KEY,
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for a malformed email', async () => {
      const response = await patchTier(
        { email: 'not-an-email', tier: 'enterprise' },
        ENTERPRISE_KEY,
      );

      expect(response.status).toBe(400);
    });

    it('returns 404 for an unknown user', async () => {
      const response = await patchTier(
        { email: 'nobody@example.com', tier: 'enterprise' },
        ENTERPRISE_KEY,
      );

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ message: 'User not found' });
    });

    it('returns 400 when the body is empty', async () => {
      const response = await patchTier({}, ENTERPRISE_KEY);

      expect(response.status).toBe(400);
    });
  });
});
