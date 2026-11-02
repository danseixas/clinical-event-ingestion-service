import { BadRequestException } from '@nestjs/common';
import { EventBodyPipe } from './event-body.pipe.js';

const pipe = new EventBodyPipe();
const meta = { type: 'body' as const };

function valid(overrides: Record<string, unknown> = {}) {
  return {
    patientId: 'p-1',
    type: 'vitals',
    ts: '2026-11-02T10:00:00Z',
    data: { hr: 72 },
    ...overrides,
  };
}

async function messagesFor(body: unknown): Promise<string[]> {
  try {
    await pipe.transform(body, meta);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (
      (error as BadRequestException).getResponse() as { message: string[] }
    ).message;
  }
  throw new Error('expected rejection');
}

const FIRST_RULES = [
  'patientId must be a string',
  'type must be a string',
  'ts must be an ISO 8601 date-time with a timezone offset',
  'data must be a JSON object',
];

describe('EventBodyPipe', () => {
  it('returns the very same body object on success', async () => {
    const body = valid();
    expect(await pipe.transform(body, meta)).toBe(body);
  });

  it.each([
    [
      'patientId missing',
      valid({ patientId: undefined }),
      ['patientId must be a string'],
    ],
    [
      'patientId number',
      valid({ patientId: 7 }),
      ['patientId must be a string'],
    ],
    [
      'patientId blank',
      valid({ patientId: '   ' }),
      ['patientId must not be blank'],
    ],
    [
      'patientId blank and long',
      valid({ patientId: ' '.repeat(129) }),
      ['patientId must not be blank'],
    ],
    [
      'patientId 129',
      valid({ patientId: 'a'.repeat(129) }),
      ['patientId must be at most 128 characters'],
    ],
    ['type missing', valid({ type: undefined }), ['type must be a string']],
    ['type blank', valid({ type: ' ' }), ['type must not be blank']],
    [
      'type 65',
      valid({ type: 'a'.repeat(65) }),
      ['type must be at most 64 characters'],
    ],
    ['ts number', valid({ ts: 5 }), [FIRST_RULES[2]]],
    ['ts no offset', valid({ ts: '2026-11-02T10:00:00' }), [FIRST_RULES[2]]],
    ['data null', valid({ data: null }), ['data must be a JSON object']],
    ['data array', valid({ data: [] }), ['data must be a JSON object']],
    ['data string', valid({ data: 'x' }), ['data must be a JSON object']],
    [
      'data missing',
      valid({ data: undefined }),
      ['data must be a JSON object'],
    ],
    [
      'extra field',
      valid({ source: 'x' }),
      ['property source should not exist'],
    ],
    [
      'top-level constructor',
      JSON.parse(
        '{"constructor":1,"patientId":"p","type":"t","ts":"2026-11-02T10:00:00Z","data":{}}',
      ),
      ['property constructor should not exist'],
    ],
  ])('rejects %s', async (_name, body, expected) => {
    expect(await messagesFor(body)).toEqual(expected);
  });

  it.each([[[]], ['x'], [1], [null], [undefined]])(
    'reports the four first-rule messages for body %j',
    async (body) => {
      expect((await messagesFor(body)).sort()).toEqual([...FIRST_RULES].sort());
    },
  );

  it('accepts 128/64 character boundaries and non-ASCII', async () => {
    await expect(
      pipe.transform(
        valid({ patientId: 'á'.repeat(128), type: 't'.repeat(64), data: {} }),
        meta,
      ),
    ).resolves.toBeDefined();
  });

  it('keeps data with constructor/prototype keys untouched', async () => {
    const data = JSON.parse(
      '{"constructor":1,"prototype":{"x":1},"__proto__":{"y":2}}',
    );
    const body = valid({ data });
    const out = await pipe.transform(body, meta);
    expect(out.data).toBe(data);
    expect(out.data).toEqual(
      JSON.parse('{"constructor":1,"prototype":{"x":1},"__proto__":{"y":2}}'),
    );
  });
});
