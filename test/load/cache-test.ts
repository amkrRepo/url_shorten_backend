import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Response shapes read by this script.
interface ShortenResponse {
  short_code: string;
}
interface CacheStats {
  enabled: boolean;
  hits: number;
  misses: number;
  hitRatio: number;
}

const BASE_URL: string = __ENV.BASE_URL;
if (!BASE_URL) {
  throw new Error(
    'BASE_URL is not set. Run `npm run test:load:cache` (loads .env.test) ' +
      'or pass it: k6 run -e BASE_URL=http://localhost:3100 ...',
  );
}

const API = `${BASE_URL}/api/v2`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Requests use k6's default text response type, so body is a string.
const bodyText = (res: { body: string | ArrayBuffer | null }): string =>
  typeof res.body === 'string' ? res.body : '';

// Share of redirects whose X-Cache header was HIT.
const cacheHitRate = new Rate('cache_hit_rate');
// Redirect latency split by cache outcome.
const hitDuration = new Trend('redirect_hit_duration', true);
const missDuration = new Trend('redirect_miss_duration', true);

export const options = {
  vus: 1,
  iterations: 100,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'checks{check:redirect: status is 302}': ['rate==1'],
  },
};

export function setup(): { shortCode: string } {
  // Start from zero hits/misses and an empty cache.
  const resetRes = http.post(`${API}/urls/cache-stats/reset`);
  if (resetRes.status !== 204) {
    throw new Error(`cache-stats reset failed: ${resetRes.status}`);
  }

  // Throwaway user in the test DB; v2 /shorten requires its API key.
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const apiKey = `load-test-key-${runId}`;
  const userRes = http.post(
    `${BASE_URL}/api/user/create`,
    JSON.stringify({
      email: `load-test-${runId}@example.com`,
      name: 'k6 load test',
      api_key: apiKey,
    }),
    { headers: JSON_HEADERS },
  );
  if (userRes.status !== 201) {
    throw new Error(
      `user create failed: ${userRes.status} ${bodyText(userRes)}`,
    );
  }

  // One URL, no password and no expiry, so it is cacheable.
  const shortenRes = http.post(
    `${API}/urls/shorten`,
    JSON.stringify({
      original_url: `https://example.com/cache-test-${runId}`,
    }),
    { headers: { ...JSON_HEADERS, 'x-api-key': apiKey } },
  );
  if (shortenRes.status !== 201) {
    throw new Error(
      `shorten failed: ${shortenRes.status} ${bodyText(shortenRes)}`,
    );
  }

  const { short_code } = shortenRes.json() as unknown as ShortenResponse;
  return { shortCode: short_code };
}

export default function (data: { shortCode: string }): void {
  const res = http.get(`${API}/urls/redirect?short_code=${data.shortCode}`, {
    redirects: 0,
    tags: { name: 'redirect' },
  });

  check(res, {
    'redirect: status is 302': (r) => r.status === 302,
    'redirect: has Location header': (r) => !!r.headers['Location'],
  });

  const hit = res.headers['X-Cache'] === 'HIT';
  cacheHitRate.add(hit);
  (hit ? hitDuration : missDuration).add(res.timings.duration);
}

export function teardown(): void {
  const stats = http
    .get(`${API}/urls/cache-stats`)
    .json() as unknown as CacheStats;

  console.log(
    `\nRedirect cache ${stats.enabled ? 'ENABLED' : 'DISABLED'}: ` +
      `hits=${stats.hits} misses=${stats.misses} (DB lookups) ` +
      `hit ratio=${(stats.hitRatio * 100).toFixed(1)}%`,
  );
}
