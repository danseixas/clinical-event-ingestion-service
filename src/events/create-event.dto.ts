import { IsObject, IsString, Matches, MaxLength } from 'class-validator';
import { IsEventTimestamp } from './is-event-timestamp.decorator.js';

// class-validator evaluates decorators bottom-up, so with stopAtFirstError the
// rule written last runs first. Order matches the RF-02 rule order.
export class CreateEventDto {
  @MaxLength(128, { message: 'patientId must be at most 128 characters' })
  @Matches(/\S/, { message: 'patientId must not be blank' })
  @IsString({ message: 'patientId must be a string' })
  patientId: string;

  @MaxLength(64, { message: 'type must be at most 64 characters' })
  @Matches(/\S/, { message: 'type must not be blank' })
  @IsString({ message: 'type must be a string' })
  type: string;

  @IsEventTimestamp({
    message: 'ts must be an ISO 8601 date-time with a timezone offset',
  })
  ts: string;

  @IsObject({ message: 'data must be a JSON object' })
  data: Record<string, unknown>;
}
