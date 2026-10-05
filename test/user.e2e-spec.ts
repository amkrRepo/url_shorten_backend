import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import { DbService } from '../src/db/db.service';
import { AppModule } from '../src/app.module';
import { TestingModule, Test } from '@nestjs/testing';

describe('User tier E2E', () => {
  let app: INestApplication;
  let dbService: DbService;

  const createUser = (payload: object) => {
    return request(app.getHttpServer())
      .post('/user/create')
      .set('Content-Type', 'application/json')
      .send(payload);
  };

  const updateUserTier = (payload: object) => {
    return request(app.getHttpServer())
      .patch('/user/tier')
      .set('Content-Type', 'application/json')
      .send(payload);
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

    dbService = moduleFixture.get<DbService>(DbService);

    await dbService.users.deleteMany({
      where: { email: { in: ['aman@example.com', 'aman2@example.com'] } },
    });

    await dbService.users.create({
      data: {
        email: 'aman@example.com',
        name: 'aman',
        api_key: 'Free_api_key',
      },
    });
  });

  afterAll(async () => {
    await dbService.users.deleteMany({
      where: { email: { in: ['aman@example.com', 'aman2@example.com'] } },
    });
    await app.close();
  });

  describe('POST user/create', () => {
    it('creates a user by free tier by default', async () => {
      const createdUser = await createUser({
        email: 'aman2@example.com',
        name: 'aman2',
        api_key: 'aman_api_key',
      });

      expect(createdUser.status).toBe(201);

      await dbService.users.deleteMany({
        where: { email: 'aman2@example.com' },
      });
    });

    it('tries creating a new user using enterprise tier', async () => {
      const createdUser = await createUser({
        email: 'aman2@example.com',
        name: 'aman2',
        api_key: 'aman_api_key',
        tier: 'enterprise',
      });

      expect(createdUser.status).toBe(400);

      await dbService.users.deleteMany({
        where: { email: 'aman2@example.com' },
      });
    });

    it('upgrates a user tier to enterprise', async () => {
      const createdUser = await createUser({
        email: 'aman2@example.com',
        name: 'aman2',
        api_key: 'aman_api_key',
      });

      expect(createdUser.status).toBe(201);

      const upgradedUser = await updateUserTier({
        email: 'aman2@example.com',
        tier: 'enterprise',
      });

      expect(upgradedUser.status).toBe(200);

      await dbService.users.deleteMany({
        where: { email: 'aman2@example.com' },
      });
    });

    it('upgrades a user tier from enterprise to free', async () => {
      const createdUser = await createUser({
        email: 'aman2@example.com',
        name: 'aman2',
        api_key: 'aman_api_key',
      });

      expect(createdUser.status).toBe(201);

      const upgradedUser = await updateUserTier({
        email: 'aman2@example.com',
        tier: 'enterprise',
      });

      expect(upgradedUser.status).toBe(200);

      // Upgrading again to 'free' from just updated to 'enterprise'
      const upgradedUserAgain = await updateUserTier({
        email: 'aman2@example.com',
        tier: 'free',
      });

      expect(upgradedUserAgain.status).toBe(400);

      await dbService.users.deleteMany({
        where: { email: 'aman2@example.com' },
      });
    });

    it('rejects an invalid email', async () => {
      const notValidUser = await createUser({
        email: 'aman.com',
        name: 'aman2',
        api_key: 'aman_api_key',
      });

      expect(notValidUser.status).toBe(400);
    });

    it('rejects an empty api_key', async () => {
      const notValidUser = await createUser({
        email: 'aman@example.com',
        name: 'aman2',
        api_key: '',
      });

      expect(notValidUser.status).toBe(400);
    });
  });

  it('rejects without an api key', async () => {
    const response = await createUser({
      email: 'aman@example.com',
      tier: 'free',
    });

    expect(response.status).toBe(401);
  });

  it('rejects for a malformed email', async () => {
    const response = await createUser({
      email: 'not-an-email',
      tier: 'free',
      api_key: 'aman_api_key',
    });

    expect(response.status).toBe(400);
  });

  it('rejects 404 for an unknown user', async () => {
    const response = await updateUserTier({
      email: 'nobody@example.com',
      tier: 'enterprise',
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ message: 'User not found' });
  });

  it('rejects when the body is empty', async () => {
    const response = await updateUserTier({});
    expect(response.status).toBe(400);
  });
});
