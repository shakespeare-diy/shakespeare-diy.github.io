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
}

/**
 * The names this signer can take back from the gateway's archive.
 *
 * Empty for anyone with nothing waiting, which is almost everyone — this is the
 * residue of one migration, not a feature of the gateway.
 */
export async function fetchNpanelClaims(
  dashboardHost: string,
  signer: NostrSigner,
  signal?: AbortSignal,
): Promise<NpanelClaim[]> {
  const response = await npanelRequest(dashboardHost, signer, 'GET', '/api/claims', undefined, signal);

  if (!response.ok) {
    throw await npanelError(response, 'Could not ask the gateway which names are waiting for you');
  }

  const { claims } = (await response.json()) as { claims: NpanelClaim[] };
  return claims;
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
