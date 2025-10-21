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

export interface ShakespeareDeployConfig {
  fs: JSRuntimeFS;
  signer: NostrSigner;
  host?: string;
  subdomain?: string;
  corsProxy?: string;
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
  nsec: string;
  gateway: string;
  relayUrls: string[];
  blossomServers: string[];
}
