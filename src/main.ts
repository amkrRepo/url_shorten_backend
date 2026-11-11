import './instrument';
import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { NextFunction, Request, Response } from 'express';

// For legacy routes.
const LEGACY_ROUTE = /^\/(urls|user)(\/|\?|$)/;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Runs onModuleDestroy on SIGTERM/SIGINT so UrlsService can flush its
  // buffered visits before the process exits.
  app.enableShutdownHooks();

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (LEGACY_ROUTE.test(req.url)) {
      req.url = `api/v1${req.url}`;
    }

    next();
  });

  // Unversioned paths.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: '/', method: RequestMethod.GET },
      { path: '/health', method: RequestMethod.GET },
    ],
  });

  // Versioned controllers resolve to /api/v1/... and /api/v2/...; without a
  // defaultVersion, unversioned ones (user, health, root) keep their paths.
  app.enableVersioning({ type: VersioningType.URI });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
