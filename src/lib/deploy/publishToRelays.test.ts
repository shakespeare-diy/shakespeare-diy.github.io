import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent, NRelay } from '@nostrify/nostrify';
import { checkRelayCoverage, forwardMissing, publishToRelays, type RelayPool } from './publishToRelays';

const RELAYS = ['wss://a.example', 'wss://b.example', 'wss://c.example'];

function event(id: string): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    kind: 35128,
    created_at: 1,
    content: '',
    tags: [],
    sig: '0'.repeat(128),
  };
}

/**
 * A pool whose relays answer however the test says.
 *
 * `verdicts` maps a relay URL to what it does with an event: `true` accepts,
 * a string refuses with that reason. `holdings` is what each relay answers a
 * query with.
 */
function pool(
  verdicts: Record<string, true | string>,
  holdings: Record<string, string[]> = {},
): RelayPool & { sent: Array<[string, string]> } {
  const sent: Array<[string, string]> = [];

  return {
    sent,
    group(urls: string[]): NRelay {
      const url = urls[0];
      return {
        async event(e: NostrEvent) {
          const verdict = verdicts[url];
          if (verdict !== true) throw new Error(verdict ?? 'no such relay');
          sent.push([url, e.id]);
        },
        async query() {
          return (holdings[url] ?? []).map(event);
        },
      } as unknown as NRelay;
    },
  };
}

describe('publishToRelays', () => {
  it('reports every relay separately, not just the first to answer', async () => {
    // Nostrify's pool resolves on the first acceptance and discards the rest,
    // which is how 97 manifests reached one relay and none reached another
    // without anything saying so.
    const relays = pool({
      'wss://a.example': true,
      'wss://b.example': 'blocked: kind 35128 is not accepted by this relay',
      'wss://c.example': true,
    });

    const outcome = await publishToRelays(relays, event('f'.repeat(64)), RELAYS);

    expect(outcome.accepted).toEqual(['wss://a.example', 'wss://c.example']);
    expect(outcome.rejected).toEqual([
      { url: 'wss://b.example', reason: 'blocked: kind 35128 is not accepted by this relay' },
    ]);
  });

  it('is a success when one relay takes it', async () => {
    const relays = pool({ 'wss://a.example': true, 'wss://b.example': 'no', 'wss://c.example': 'no' });

    // The event exists, and a gateway reading the relay that has it will find
    // it. Failing the deploy over the other two would be wrong about something
    // the user can see working.
    await expect(publishToRelays(relays, event('f'.repeat(64)), RELAYS)).resolves.toMatchObject({
      accepted: ['wss://a.example'],
    });
  });

  it('fails, with every reason, when nobody takes it', async () => {
    const relays = pool({
      'wss://a.example': 'blocked: rate limited',
      'wss://b.example': 'invalid: bad signature',
      'wss://c.example': 'error: down',
    });

    await expect(publishToRelays(relays, event('f'.repeat(64)), RELAYS)).rejects.toThrow(
      /No relay accepted.*a\.example: blocked: rate limited.*b\.example: invalid: bad signature/s,
    );
  });

  it('refuses to publish nowhere', async () => {
    await expect(publishToRelays(pool({}), event('f'.repeat(64)), [])).rejects.toThrow(/No relays/);
  });
});

describe('relay coverage', () => {
  it('sends each relay only what it is missing, unchanged', async () => {
    const events = [event('1'.repeat(64)), event('2'.repeat(64))];

    const relays = pool(
      { 'wss://a.example': true, 'wss://b.example': true, 'wss://c.example': true },
      {
        'wss://a.example': [events[0].id, events[1].id],
        'wss://b.example': [events[0].id],
        'wss://c.example': [],
      },
    );

    const coverage = await checkRelayCoverage(relays, RELAYS, events.map((e) => e.id));
    expect(coverage.map((c) => c.present.size)).toEqual([2, 1, 0]);

    const result = await forwardMissing(relays, coverage, events);

    expect(result.filled.get('wss://a.example')).toBeUndefined();
    expect(result.filled.get('wss://b.example')).toBe(1);
    expect(result.filled.get('wss://c.example')).toBe(2);
    // The same events, so no signer is involved and a second run is harmless.
    expect(relays.sent).toEqual([
      ['wss://b.example', events[1].id],
      ['wss://c.example', events[0].id],
      ['wss://c.example', events[1].id],
    ]);
  });

  it('asks a refusing relay once and reports what it said', async () => {
    const events = [event('1'.repeat(64)), event('2'.repeat(64)), event('3'.repeat(64))];

    const relays = pool({ 'wss://a.example': 'blocked: not accepting these' }, { 'wss://a.example': [] });

    const coverage = await checkRelayCoverage(relays, ['wss://a.example'], events.map((e) => e.id));
    const result = await forwardMissing(relays, coverage, events);

    // Three copies of one sentence is not more information than one.
    expect(result.refused.get('wss://a.example')).toBe('blocked: not accepting these');
    expect(relays.sent).toHaveLength(0);
  });

  it('tells a relay that cannot be reached apart from one holding nothing', async () => {
    const relays: RelayPool = {
      group: () =>
        ({
          query: () => Promise.reject(new Error('connection refused')),
          event: () => Promise.resolve(),
        }) as unknown as NRelay,
    };

    const coverage = await checkRelayCoverage(relays, ['wss://a.example'], ['1'.repeat(64)]);

    // One is a relay to send to, the other is a relay to try again later.
    expect(coverage[0].error).toBe('connection refused');
    expect(coverage[0].present.size).toBe(0);
  });

  it('calls a timeout silence rather than a verdict', async () => {
    const relays: RelayPool = {
      group: () =>
        ({
          event: () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
        }) as unknown as NRelay,
    };

    await expect(publishToRelays(relays, event('f'.repeat(64)), ['wss://a.example'])).rejects.toThrow(
      /no answer before the timeout/,
    );
  });
});

describe('NsiteAdapter integration point', () => {
  it('passes the pool through without a group of its own', async () => {
    // The adapter used to call `nostr.group(relays).event(...)`, whose
    // Promise.any hid this entirely.
    const relays = pool({ 'wss://a.example': true });
    const spy = vi.spyOn(relays, 'group');

    await publishToRelays(relays, event('f'.repeat(64)), ['wss://a.example']);

    expect(spy).toHaveBeenCalledWith(['wss://a.example']);
  });
});
