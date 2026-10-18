import 'dotenv/config';
import * as Sentry from '@sentry/nestjs';

// Must run before any other import (see main.ts) so Sentry can patch
// express/http. With no SENTRY_DSN set, init is a no-op.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  // Request bodies carry secrets (api_key on /user/create, link passwords),
  // so never attach them to events or spans.
  dataCollection: { httpBodies: [] },
});
