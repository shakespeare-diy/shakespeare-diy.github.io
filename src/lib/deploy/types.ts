import type { JSRuntimeFS } from '../JSRuntime';
import type { NostrSigner, NPool } from '@nostrify/nostrify';

export interface DeployOptions {
  /** Project ID */
  projectId: string;
  /** Path to the project directory */
  projectPath: string;
}

export interface DeployResult {
  /** The deployed URL */
  url: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface DeployAdapter {
  /** Deploy a project */
  deploy(options: DeployOptions): Promise<DeployResult>;
}

export interface NetlifyDeployConfig {
  fs: JSRuntimeFS;
  apiKey: string;
  baseURL?: string;
  siteName?: string;
  siteId?: string;
  corsProxy?: string;
}

export interface VercelDeployConfig {
  fs: JSRuntimeFS;
  apiKey: string;
  baseURL?: string;
  teamId?: string;
  projectName?: string;
  corsProxy?: string;
}

export interface NsiteDeployConfig {
  fs: JSRuntimeFS;
  nostr: NPool;
  /** Nostr signer for the logged-in user — used to sign auth events and the manifest */
  signer: NostrSigner;
  gateway: string;
  relayUrls: string[];
  blossomServers: string[];
  /** Optional site title included as a ["title", ...] tag in the manifest */
  siteTitle?: string;
  /** Optional site description included as a ["description", ...] tag in the manifest */
  siteDescription?: string;
  /** Optional source repository location included as a ["source", ...] tag in the manifest */
  sourceUrl?: string;
  /**
   * Optional named-site identifier (the `d` tag value).
   * When set → publishes kind 35128 (named site), URL = {base36pubkey}{identifier}.{gateway}
   * When absent → publishes kind 15128 (root site), URL = {npub}.{gateway}
   */
  siteIdentifier?: string;
}

/**
 * A gateway that serves an nsite under a name it holds for you.
 *
 * `siteIdentifier` is not configurable: the gateway's hostname and the site's
 * `d` tag are the same label, so that a second gateway asked to serve the site
 * lands on the same name.
 */
export interface NpanelDeployConfig extends Omit<NsiteDeployConfig, 'siteIdentifier'> {
  /**
   * The gateway's dashboard hostname, which is also its API origin — the `u`
   * tag of every NIP-98 request has to name it, so it is not interchangeable
   * with the domain sites are served under.
   */
  dashboardHost: string;
  /** The domain the site is served under, e.g. `shakespeare.wtf`. */
  domain: string;
  /** The single label in front of {@link domain}, and the site's `d` tag. */
  subdomain: string;
}

export interface CloudflareDeployConfig {
  fs: JSRuntimeFS;
  apiKey: string;
  accountId: string;
  baseURL?: string;
  baseDomain?: string;
  projectName?: string;
  corsProxy?: string;
  esmUrl: string;
}

export interface DenoDeployConfig {
  fs: JSRuntimeFS;
  apiKey: string;
  organizationId: string;
  baseURL?: string;
  baseDomain?: string;
  projectName?: string;
  corsProxy?: string;
}

export interface RailwayDeployConfig {
  fs: JSRuntimeFS;
  apiKey: string;
  baseURL?: string;
  workspaceId?: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  projectName?: string;
  corsProxy?: string;
}

export interface PresetDeployProvider {
  id: string;
  type: 'npanel' | 'netlify' | 'vercel' | 'nsite' | 'cloudflare' | 'deno' | 'railway';
  name: string;
  description: string;
  baseURL?: string;
  requiresNostr?: boolean;
  apiKeyLabel?: string;
  apiKeyURL?: string;
  accountIdLabel?: string;
  accountIdURL?: string;
  organizationIdLabel?: string;
  organizationIdURL?: string;
  proxy?: boolean;
}
