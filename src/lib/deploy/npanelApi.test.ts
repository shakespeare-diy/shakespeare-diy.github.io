import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPublicKey, generateSecretKey } from 'nostr-tools';
import type { NostrSigner } from '@nostrify/nostrify';
import { fetchNpanelClaimCount } from './npanelApi';

const DASHBOARD_HOST = 'npanel.example.test';

const pubkey = getPublicKey(generateSecretKey());

/**
 * A signer that fills in the fields a real one would, without signing.
 *
 * Signing for real is not available here: jsdom's TextEncoder returns a
 * Uint8Array from its own realm, which fails the `instanceof` check inside
 * @noble/hashes, so nostr-tools cannot hash an event under this environment.
 * Nothing here verifies a signature — what matters is which request goes out
 * and what is made of the answer.
 */
const signer: NostrSigner = {
  getPublicKey: async () => pubkey,
  signEvent: async (template) => ({
    ...template,
    id: 'f'.repeat(64),
    pubkey,
    sig: '0'.repeat(128),
  }),
} as NostrSigner;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchNpanelClaimCount', () => {
  it('asks the gateway only for the count', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ waiting: 3, taken: 1 })));

    await expect(fetchNpanelClaimCount(DASHBOARD_HOST, signer)).resolves.toEqual({
      waiting: 3,
      taken: 1,
    });

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe(`https://${DASHBOARD_HOST}/api/claims?summary=1`);
    expect(request.headers.get('Authorization')).toMatch(/^Nostr /);
  });

  it('reports nothing waiting when the gateway answers with the list instead', async () => {
    // An older gateway ignores the parameter and returns every claim, which is
    // a different shape rather than a bigger number — counting it would be
    // inventing one.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ claims: [{ hostname: `a.example.test` }] })),
    );

    await expect(fetchNpanelClaimCount(DASHBOARD_HOST, signer)).resolves.toEqual({
      waiting: 0,
      taken: 0,
    });
  });

  it('reports nothing waiting when the gateway cannot be reached', async () => {
    // This runs because somebody opened a settings page. A number that failed
    // to arrive is not an error worth showing them.
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(fetchNpanelClaimCount(DASHBOARD_HOST, signer)).resolves.toEqual({
      waiting: 0,
      taken: 0,
    });
  });

  it('reports nothing waiting when the gateway refuses', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));

    await expect(fetchNpanelClaimCount(DASHBOARD_HOST, signer)).resolves.toEqual({
      waiting: 0,
      taken: 0,
    });
  });
});
