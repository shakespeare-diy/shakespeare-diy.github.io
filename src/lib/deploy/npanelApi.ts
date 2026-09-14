import { NIP98 } from '@nostrify/nostrify';
import { N64 } from '@nostrify/nostrify/utils';
import type { NostrSigner } from '@nostrify/nostrify';

/** Timeout for a single API call (ms). */
export const NPANEL_TIMEOUT_MS = 15_000;

/**
 * A NIP-98 request to an npanel gateway's API.
 *
 * Signed against the URL being requested, so the token authorizes this call and
 * no other. No CORS proxy: npanel answers browsers directly, and a proxy would
 * rewrite the URL out from under the signature.
 */
export async function npanelRequest(
  dashboardHost: string,
  signer: NostrSigner,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `https://${dashboardHost}${path}`;

  let request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });

  const template = await NIP98.template(request);
  const event = await signer.signEvent(template);

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Nostr ${N64.encodeEvent(event)}`);
  request = new Request(request, {
    headers,
    signal: signal ?? AbortSignal.timeout(NPANEL_TIMEOUT_MS),
  });

  return await fetch(request);
}

/** The gateway's own sentence about a failure, which is written to be read. */
export async function npanelError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;

  if (response.status === 403 && !body?.error) {
    return new Error(`${fallback}: this gateway is not accepting new sites right now.`);
  }

  return new Error(body?.error ?? `${fallback} (HTTP ${response.status}).`);
}

/** An nsite manifest, reduced to the parts that are the site. */
export interface NpanelClaimManifest {
  kind: number;
  content: string;
  tags: string[][];
}

/** A name waiting to be handed back to whoever held it before this gateway. */
export interface NpanelClaim {
  hostname: string;
  /** Where the record came from, eg `picohost`. */
  source: string;
  /** Whether something is being served at the name right now. */
  live: boolean;
  /** Where the name points today, as `kind:pubkey:identifier`, or null if nowhere. */
  address: string | null;
  /** Whether that address is already the claimant's own key. */
  mine: boolean;
  /** The archive's copy, when there is one to republish. Null when `mine`. */
  manifest: NpanelClaimManifest | null;
  /**
   * Whether this name has already been taken back.
   *
   * Absent from gateways that predate the field, which is why it is optional
   * rather than assumed false: a list of waiting names is what `GET /api/claims`
   * has always returned, so a missing flag means the row is waiting.
   */
  claimed?: boolean;
  /** What the site calls itself, where the gateway could work it out. */
  suggestedTitle?: string | null;
  suggestedDescription?: string | null;
}

/**
 * The names this signer can take back from the gateway's archive.
 *
 * Empty for anyone with nothing waiting, which is almost everyone — this is the
 * residue of one migration, not a feature of the gateway.
 *
 * `taken` also returns names already claimed, which is how an app fixes
 * something about how it claimed them. Older gateways ignore the parameter and
 * answer with the waiting ones, which is a smaller answer rather than a wrong
 * one.
 */
export async function fetchNpanelClaims(
  dashboardHost: string,
  signer: NostrSigner,
  signal?: AbortSignal,
  opts: { taken?: boolean } = {},
): Promise<NpanelClaim[]> {
  const path = opts.taken ? '/api/claims?taken=1' : '/api/claims';
  const response = await npanelRequest(dashboardHost, signer, 'GET', path, undefined, signal);

  if (!response.ok) {
    throw await npanelError(response, 'Could not ask the gateway which names are waiting for you');
  }

  const { claims } = (await response.json()) as { claims: NpanelClaim[] };
  return claims;
}

/** How many names a gateway is holding for somebody, and how many they took. */
export interface NpanelClaimCount {
  waiting: number;
  taken: number;
}

/**
 * The count alone, without working out what to do about any of them.
 *
 * {@link fetchNpanelClaims} reads every file of every claimed deploy and returns
 * a manifest each, which is the right price for the dialog that hands the names
 * back and much too high for the sentence that gets somebody to open it. A
 * gateway too old to know the parameter answers with the list instead, so the
 * shape is checked rather than assumed — and a gateway that fails outright
 * reports nothing waiting, since a number nobody can fetch should not become an
 * error on a settings page.
 */
export async function fetchNpanelClaimCount(
  dashboardHost: string,
  signer: NostrSigner,
  signal?: AbortSignal,
): Promise<NpanelClaimCount> {
  const none: NpanelClaimCount = { waiting: 0, taken: 0 };

  try {
    const response = await npanelRequest(
      dashboardHost,
      signer,
      'GET',
      '/api/claims?summary=1',
      undefined,
      signal,
    );
    if (!response.ok) return none;

    const body = (await response.json()) as Partial<NpanelClaimCount>;
    if (typeof body.waiting !== 'number' || typeof body.taken !== 'number') return none;

    return { waiting: body.waiting, taken: body.taken };
  } catch {
    return none;
  }
}

/** Point a name waiting for this signer at a site they published. */
export async function claimNpanelHostname(
  dashboardHost: string,
  signer: NostrSigner,
  hostname: string,
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await npanelRequest(
    dashboardHost,
    signer,
    'POST',
    `/api/claims/${encodeURIComponent(hostname)}`,
    { address },
    signal,
  );

  if (!response.ok) {
    throw await npanelError(response, `Could not take back ${hostname}`);
  }
}
