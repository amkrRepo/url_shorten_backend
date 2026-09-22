// @ts-nocheck – k6 modules are provided by the k6 runtime, not npm
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL: string = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '30s', target: 800 },
    { duration: '1m', target: 800 },
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(50)<200', 'p(90)<600', 'p(95)<700', 'p(99)<900'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function (): void {
  const payload: string = JSON.stringify({
    original_url: `https://example.com/smoke-test-${__VU}-${Date.now()}`,
  });

  const shortenRes = http.post(`${BASE_URL}/urls/shorten`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(shortenRes, {
    'shorten: status is 201': (r: typeof shortenRes): boolean =>
      r.status === 201,
    'shorten: response has short_code': (r: typeof shortenRes): boolean => {
      try {
        if (!r.body) return false;
        return typeof JSON.parse(r.body as string).short_code === 'string';
      } catch (e) {
        return false;
      }
    },
  });

  let shortCode: string | null = null;
  try {
    if (shortenRes.body) {
      shortCode = JSON.parse(shortenRes.body as string).short_code ?? null;
    }
  } catch (e) {
    shortCode = null;
  }

  if (shortCode) {
    const redirectRes = http.get(
      `${BASE_URL}/urls/redirect?short_code=${shortCode}`,
      { redirects: 0, tags: { name: 'redirect' } },
    );

    check(redirectRes, {
      'redirect: status is 302': (r: typeof redirectRes): boolean =>
        r.status === 302,
      'redirect: has Location header': (r: typeof redirectRes): boolean =>
        !!r.headers['Location'],
    });
  }

  sleep(1);
}
