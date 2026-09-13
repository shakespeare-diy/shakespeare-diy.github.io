import type { NostrSigner } from '@nostrify/nostrify';
import type { DeployAdapter, DeployOptions, DeployResult, NpanelDeployConfig } from './types';
import { NsiteAdapter } from './NsiteAdapter';
import { NPANEL_TIMEOUT_MS, npanelError, npanelRequest } from './npanelApi';

/** nsite named-site kind. An npanel host always points at one of these. */
const NAMED_SITE_KIND = 35128;

/** What `GET /api/hosts/:hostname/available` answers. */
export interface NameAvailability {
  hostname: string;
  available: boolean;
  reason?: 'taken' | 'invalid';
  /** Present when `reason` is `invalid`; written to be shown to whoever typed it. */
  error?: string;
}

/**
 * Ask whether a name can still be claimed.
 *
 * Unauthenticated, and deliberately so: someone choosing a name has not decided
 * to make an account yet, and making them prove who they are to find out their
 * first choice is taken would be a strange order to do things in.
 *
 * A network failure answers `available: true` rather than blocking the person.
 * Being wrong that way costs a clear error at deploy time; being wrong the other
 * way tells someone a free name is taken and they pick a worse one.
 */
export async function checkNameAvailable(
  dashboardHost: string,
  hostname: string,
  signal?: AbortSignal,
): Promise<NameAvailability> {
  const url = `https://${dashboardHost}/api/hosts/${encodeURIComponent(hostname)}/available`;

  try {
    const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(NPANEL_TIMEOUT_MS) });
    if (!response.ok) return { hostname, available: true };
    return (await response.json()) as NameAvailability;
  } catch {
    return { hostname, available: true };
  }
}

/**
 * Deploy to an npanel gateway: publish an nsite, then point a hostname at it.
 *
 * The site itself is an ordinary nsite published under the user's own key — this
 * adapter delegates all of that to {@link NsiteAdapter} rather than reimplementing
 * it, so a site deployed here is the same site, readable by any nsite client,
 * with or without this gateway.
 *
 * What npanel adds is the name. Its predecessor claimed one implicitly, by
 * watching relays for a manifest and reserving whatever `d` tag it saw first;
 * npanel instead keeps an explicit hostname → nsite row, which is what makes a
 * name something its owner holds rather than something they won a race for.
 * That row has to be asked for, which is the second half of this deploy.
 */
export class NpanelAdapter implements DeployAdapter {
  private readonly nsite: NsiteAdapter;
  private readonly signer: NostrSigner;
  private readonly dashboardHost: string;
  private readonly hostname: string;
  private readonly subdomain: string;

  constructor(config: NpanelDeployConfig) {
    this.signer = config.signer;
    this.dashboardHost = config.dashboardHost;
    this.subdomain = config.subdomain;
    this.hostname = `${config.subdomain}.${config.domain}`;

    // The identifier is the subdomain, so a site's name and its address agree
    // and a second gateway asked to serve it lands on the same name.
    this.nsite = new NsiteAdapter({ ...config, siteIdentifier: config.subdomain });
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const result = await this.nsite.deploy(options);

    const pubkey = await this.signer.getPublicKey();
    const address = `${NAMED_SITE_KIND}:${pubkey}:${this.subdomain}`;

    await this.bindHostname(address);

    return {
      url: `https://${this.hostname}`,
      metadata: {
        ...result.metadata,
        provider: 'npanel',
        hostname: this.hostname,
        address,
        /** The URL any nsite gateway serves this at, gateway or no gateway. */
        canonicalUrl: result.metadata?.canonicalUrl ?? result.url,
      },
    };
  }

  /**
   * Point {@link hostname} at `address`, whether or not it already exists.
   *
   * Asked about before being claimed, because the three outcomes are different
   * acts: a name nobody holds is created, a name this user already holds is
   * repointed — that is what a redeploy under a new key or a renamed site looks
   * like — and a name somebody else holds is refused. Creating first and reading
   * the 409 could not tell the last two apart.
   */
  private async bindHostname(address: string): Promise<void> {
    const existing = await this.request('GET', `/api/hosts/${encodeURIComponent(this.hostname)}`);

    if (existing.status === 200) {
      const { host } = (await existing.json()) as { host: { address: string } };
      if (host.address === address) return;

      const patched = await this.request(
        'PATCH',
        `/api/hosts/${encodeURIComponent(this.hostname)}`,
        { address },
      );
      if (!patched.ok) throw await this.error(patched, `Could not update ${this.hostname}`);
      return;
    }

    if (existing.status === 403) {
      throw new Error(
        `${this.hostname} belongs to someone else. Choose a different name for this site.`,
      );
    }

    if (existing.status !== 404) {
      throw await this.error(existing, `Could not check whether ${this.hostname} is free`);
    }

    const created = await this.request('POST', '/api/hosts', { hostname: this.hostname, address, spa: true });
    if (created.ok) return;

    // Between the check and the claim, somebody else took it.
    if (created.status === 409) {
      throw new Error(`${this.hostname} was just taken. Choose a different name for this site.`);
    }

    throw await this.error(created, `Could not claim ${this.hostname}`);
  }

  /** A NIP-98 request to the gateway's API. */
  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return npanelRequest(this.dashboardHost, this.signer, method, path, body);
  }

  /** The gateway's own sentence about a failure, which is written to be read. */
  private error(response: Response, fallback: string): Promise<Error> {
    return npanelError(response, fallback);
  }
}
