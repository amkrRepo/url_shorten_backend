import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Mirrored by the pipe in test/url.e2e-spec.ts so validation behaves
  // identically in tests and production. `forbidNonWhitelisted` rejects
  // body keys that are not on the DTO (e.g. `tier` on POST /user/create).
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
