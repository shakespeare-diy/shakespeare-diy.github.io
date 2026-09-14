import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import { NpanelAdapter, checkNameAvailable } from './NpanelAdapter';
import type { JSRuntimeFS } from '../JSRuntime';

const DASHBOARD_HOST = 'npanel.example.test';
const DOMAIN = 'example.test';

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

/**
 * A signer that fills in the fields a real one would, without signing.
 *
 * Not a shortcut around something worth testing: the adapter never verifies a
 * signature, it base64-encodes whatever it is handed, so what these tests are
 * about is which tags end up on the event and where it gets sent. Signing for
 * real is also not available here — jsdom's TextEncoder returns a Uint8Array
 * from its own realm, which fails the `instanceof` check inside @noble/hashes,
 * so nostr-tools cannot hash an event under this test environment at all.
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

/** Requests the adapter made, so a test can assert what it asked the gateway. */
interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth: NostrEvent;
}

let calls: Call[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * An adapter whose nsite half is stubbed out.
 *
 * Publishing the site is {@link NsiteAdapter}'s job and is covered where it
 * lives; what is worth pinning down here is the second half — which requests
 * the gateway gets, and what happens when it says no.
 */
function adapterWithStubbedSite(subdomain: string): NpanelAdapter {
  const adapter = new NpanelAdapter({
    fs: {} as JSRuntimeFS,
    nostr: {} as never,
    signer,
    dashboardHost: DASHBOARD_HOST,
    domain: DOMAIN,
    subdomain,
    gateway: DOMAIN,
    relayUrls: [],
    blossomServers: [],
  });

  const inner = (adapter as unknown as { nsite: { deploy: unknown } }).nsite;
  inner.deploy = vi.fn(async () => ({
    url: `https://base36.${DOMAIN}`,
    metadata: { canonicalUrl: `https://base36.${DOMAIN}`, filesPublished: 3 },
  }));

  return adapter;
}

/** Respond to the adapter's requests in the order it makes them. */
function respondWith(...responses: Array<{ status: number; body?: unknown }>): void {
  let index = 0;

  fetchMock.mockImplementation(async (request: Request) => {
    const header = request.headers.get('Authorization') ?? '';
    const auth = JSON.parse(atob(header.replace(/^Nostr /, ''))) as NostrEvent;
    const body = request.body ? await request.clone().json() : undefined;

    calls.push({ method: request.method, path: new URL(request.url).pathname, body, auth });

    const next = responses[index++] ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  calls = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NpanelAdapter', () => {
  it('claims an unused name and returns the hostname it got', async () => {
    respondWith({ status: 404, body: { error: 'Host not found.' } }, { status: 201, body: { host: {} } });

    const result = await adapterWithStubbedSite('mysite').deploy({
      projectId: 'p',
      projectPath: '/projects/p',
    });

    expect(result.url).toBe(`https://mysite.${DOMAIN}`);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/hosts/mysite.${DOMAIN}`,
      'POST /api/hosts',
    ]);

    // The site is served from a manifest that may not have every path, so the
    // gateway has to be told to fall back to the shell rather than 404.
    expect(calls[1].body).toMatchObject({
      hostname: `mysite.${DOMAIN}`,
      address: `35128:${pubkey}:mysite`,
      spa: true,
    });
  });

  it('signs each request for the URL it is sent to', async () => {
    respondWith({ status: 404 }, { status: 201, body: { host: {} } });

    await adapterWithStubbedSite('mysite').deploy({ projectId: 'p', projectPath: '/projects/p' });

    for (const call of calls) {
      const tag = (name: string) => call.auth.tags.find(([k]) => k === name)?.[1];

      expect(call.auth.kind).toBe(27235);
      expect(call.auth.pubkey).toBe(pubkey);
      expect(tag('method')).toBe(call.method);
      expect(tag('u')).toBe(`https://${DASHBOARD_HOST}${call.path}`);
    }
  });

  it('leaves a name alone when it already points at this site', async () => {
    respondWith({
      status: 200,
      body: { host: { address: `35128:${pubkey}:mysite` } },
    });

    await adapterWithStubbedSite('mysite').deploy({ projectId: 'p', projectPath: '/projects/p' });

    // A redeploy is the common case; it should cost one read and no write.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('repoints a name it holds that points somewhere else', async () => {
    respondWith(
      { status: 200, body: { host: { address: '35128:someoneelse:mysite' } } },
      { status: 200, body: { host: {} } },
    );

    await adapterWithStubbedSite('mysite').deploy({ projectId: 'p', projectPath: '/projects/p' });

    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body).toEqual({ address: `35128:${pubkey}:mysite` });
  });

  it('says plainly when a name belongs to someone else', async () => {
    respondWith({ status: 403, body: { error: "You don't have access to this host." } });

    await expect(
      adapterWithStubbedSite('taken').deploy({ projectId: 'p', projectPath: '/projects/p' }),
    ).rejects.toThrow(/belongs to someone else/);
  });

  it('says plainly when a name is claimed between the check and the claim', async () => {
    respondWith({ status: 404 }, { status: 409, body: { error: 'already configured.' } });

    await expect(
      adapterWithStubbedSite('racy').deploy({ projectId: 'p', projectPath: '/projects/p' }),
    ).rejects.toThrow(/was just taken/);
  });

  it("passes on the gateway's own explanation of a refusal", async () => {
    respondWith(
      { status: 404 },
      { status: 403, body: { error: 'You already have 25 sites here, which is the limit.' } },
    );

    await expect(
      adapterWithStubbedSite('over-quota').deploy({ projectId: 'p', projectPath: '/projects/p' }),
    ).rejects.toThrow(/25 sites here/);
  });
});

describe('checkNameAvailable', () => {
  it('reports what the gateway says', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: false, reason: 'taken' })),
    );

    await expect(checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`)).resolves.toMatchObject({
      available: false,
      reason: 'taken',
    });
  });

  it('asks without credentials', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ hostname: 'x', available: true })));

    await checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://${DASHBOARD_HOST}/api/hosts/x.${DOMAIN}/available`);
    expect((init as RequestInit | undefined)?.headers).toBeUndefined();
  });

  it('treats an unreachable gateway as available', async () => {
    // Being wrong this way costs a clear error at deploy time. Being wrong the
    // other way tells somebody a free name is taken and they settle for worse.
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`)).resolves.toMatchObject({
      available: true,
    });
  });

  it('asks again as the signer when a name comes back taken', async () => {
    // "Taken" and "taken by you" are the same word to a stranger and opposite
    // answers to the person about to deploy.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: false, reason: 'taken' })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: true, reason: 'mine' })),
      );

    await expect(
      checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`, undefined, signer),
    ).resolves.toMatchObject({ available: true, reason: 'mine' });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The first ask carries nothing; only the second spends a signature.
    const [, anonymous] = fetchMock.mock.calls[0];
    expect((anonymous as RequestInit | undefined)?.headers).toBeUndefined();

    const signed = fetchMock.mock.calls[1][0] as Request;
    expect(signed.headers.get('Authorization')).toMatch(/^Nostr /);
    expect(signed.url).toBe(`https://${DASHBOARD_HOST}/api/hosts/x.${DOMAIN}/available`);
  });

  it('spends no signature on a name that is free', async () => {
    // Picking a new name is the common case, and a remote signer on the other
    // end of every keystroke is not something to spend it on.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ hostname: 'x', available: true })));

    await checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`, undefined, signer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the public answer when the gateway is too old to know better', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: false, reason: 'taken' })),
      )
      .mockResolvedValueOnce(new Response('nope', { status: 404 }));

    await expect(
      checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`, undefined, signer),
    ).resolves.toMatchObject({ available: false, reason: 'taken' });
  });
});

describe('checkNameAvailable, for a name held for its previous owner', () => {
  it('reports waiting rather than taken', async () => {
    // The state almost every unclaimed name is in: an archive serving it, so
    // the public answer is taken and the useful answer is that it is theirs.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: false, reason: 'taken' })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: false, reason: 'waiting' })),
      );

    await expect(
      checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`, undefined, signer),
    ).resolves.toMatchObject({ available: false, reason: 'waiting' });
  });

  it('says nothing more to somebody who did not sign', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ hostname: `x.${DOMAIN}`, available: false, reason: 'taken' })),
    );

    await expect(checkNameAvailable(DASHBOARD_HOST, `x.${DOMAIN}`)).resolves.toMatchObject({
      reason: 'taken',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
