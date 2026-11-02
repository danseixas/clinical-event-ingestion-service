import { registerDecorator, ValidationOptions } from 'class-validator';
import { parseEventTimestamp } from './event-timestamp.js';

export function IsEventTimestamp(
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: 'isEventTimestamp',
      target: target.constructor,
      propertyName: propertyKey as string,
      options,
      validator: {
        validate: (value: unknown) => parseEventTimestamp(value) !== null,
      },
    });
  };
}
