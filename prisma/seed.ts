import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { generateShortCode } from '../common/short-code-utils';
import { seedUsers } from './seed-users';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

const SEED_COUNT = Number(process.env.SEED_COUNT ?? 1_00000);
const BATCH_SIZE = 1_000;
const PAST_DAYS = 90;
const PAST_MS = PAST_DAYS * 24 * 60 * 60 * 1000;

function randomCreatedAt(): Date {
  const now = Date.now();
  return new Date(now - Math.floor(Math.random() * PAST_MS));
}

function buildBatch(batchIndex: number, size: number, userIds: number[]) {
  const rows: {
    original_url: string;
    short_code: string;
    created_at: Date;
    user_id: number;
  }[] = [];
  for (let i = 0; i < size; i++) {
    const globalIndex = batchIndex * BATCH_SIZE + i;
    rows.push({
      original_url: `https://example.com/dummy-resource/${globalIndex}`,
      short_code: generateShortCode(),
      created_at: randomCreatedAt(),
      user_id: userIds[globalIndex % userIds.length],
    });
  }
  return rows;
}

async function main() {
  const userIds = await seedUsers(prisma);
  if (userIds.length === 0) {
    throw new Error('No users were seeded; cannot assign user_id to Url rows.');
  }

  console.log(`Seeding ${SEED_COUNT} Url rows in batches of ${BATCH_SIZE}...`);
  const startedAt = Date.now();
  const totalBatches = Math.ceil(SEED_COUNT / BATCH_SIZE);
  let inserted = 0;

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const remaining = SEED_COUNT - inserted;
    const size = Math.min(BATCH_SIZE, remaining);
    const rows = buildBatch(batchIndex, size, userIds);

    const result = await prisma.urls.createMany({
      data: rows,
    });

    inserted += result.count;
    console.log(
      `Batch ${batchIndex + 1}/${totalBatches} — inserted ${result.count} (${inserted}/${SEED_COUNT} total)`,
    );
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Done. Inserted ${inserted} rows in ${elapsedSeconds}s.`);
}

main()
  .catch((error) => {
    console.error('Seed script failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
