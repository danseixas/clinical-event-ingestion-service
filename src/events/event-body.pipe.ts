import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
  ValidationPipe,
} from '@nestjs/common';
import { CreateEventDto } from './create-event.dto.js';

// Nest's stripProtoKeys removes these names from the validated object, which
// would hide them from the whitelist check. They can never be DTO fields.
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class EventBodyPipe implements PipeTransform<
  unknown,
  Promise<CreateEventDto>
> {
  private readonly delegate = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    stopAtFirstError: true,
    expectedType: CreateEventDto,
  });

  async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<CreateEventDto> {
    const body = isPlainObject(value) ? value : {};
    const messages: string[] = [];

    // Validate a clone: the delegate mutates its input (stripProtoKeys) and the
    // original body, including `data`, must reach storage as received.
    try {
      await this.delegate.transform(structuredClone(body), metadata);
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      const response = error.getResponse() as { message?: string | string[] };
      messages.push(...[response.message ?? []].flat());
    }

    for (const key of RESERVED_KEYS) {
      if (Object.hasOwn(body, key)) {
        messages.push(`property ${key} should not exist`);
      }
    }

    if (messages.length > 0) throw new BadRequestException(messages);
    return body as unknown as CreateEventDto;
  }
}
