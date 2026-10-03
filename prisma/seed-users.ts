import { randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client';

const TOTAL_USERS = Number(process.env.SEED_USERS ?? 3);

export async function seedUsers(prisma: PrismaClient): Promise<number[]> {
  console.log(`Seeding ${TOTAL_USERS} users...`);
  const startedAt = Date.now();

  // Creating new users in memory.
  const rows = Array.from({ length: TOTAL_USERS }, (_, index) => ({
    email: `user${index + 1}@example.com`,
    name: `User ${index + 1}`,
    api_key: randomBytes(32).toString('hex'),
  }));

  // Checking if the created users already exists or not.
  const existing = await prisma.users.findMany({
    where: { email: { in: rows.map((row) => row.email) } },
    select: { id: true, email: true },
  });
  const idByEmail = new Map(existing.map((user) => [user.email, user.id]));

  // Intially all users are missing, After 1st run only new users come under missing.
  // For adding a new set of users, We need to either increase the num of total_users or reset the DB with existing ones.
  const missing = rows.filter((row) => !idByEmail.has(row.email));
  if (missing.length > 0) {
    const created = await prisma.users.createManyAndReturn({
      data: missing,
      select: { id: true, email: true },
    });
    for (const user of created) {
      idByEmail.set(user.email, user.id);
    }
  }

  const userIds = rows.map((row) => idByEmail.get(row.email)!);

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Done. Seeded ${userIds.length} users in ${elapsedSeconds}s — ids: ${userIds.join(', ')}.`,
  );
  return userIds;
}
