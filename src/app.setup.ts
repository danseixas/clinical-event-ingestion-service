import { BadRequestException } from '@nestjs/common';
import { NestApplicationOptions } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

// Only the JSON parser is registered: Nest's default urlencoded parser would
// let a form body reach validation as if it were an event.
export const appOptions: NestApplicationOptions = { bodyParser: false };

export function configureApp(app: NestExpressApplication): void {
  // strict: false lets arrays and primitives reach validation (RF-02).
  app.useBodyParser('json', { strict: false });
  // The parser's message quotes fragments of the body; replace it (spec D-16).
  app.use(
    (error: unknown, _req: Request, _res: Response, next: NextFunction) => {
      if ((error as { type?: string } | null)?.type === 'entity.parse.failed') {
        next(new BadRequestException('Malformed JSON body'));
        return;
      }
      next(error);
    },
  );
}
