import { createContext } from 'react';

export interface BaseDeployProvider {
  id: string;
  name: string;
}

/**
 * A gateway that serves nsites under a domain it hands out names on.
 *
 * The site is an ordinary nsite under the user's own key; what the gateway adds
 * is the hostname, which it has to be asked for. `dashboardHost` is where that
 * asking happens and `domain` is what the site is served under — usually two
 * different names, and never assumed to be the same one.
 */
export interface NpanelProvider extends BaseDeployProvider {
  type: 'npanel';
  dashboardHost: string;
  domain: string;
  relayUrls: string[];
  blossomServers: string[];
}

export interface NetlifyProvider extends BaseDeployProvider {
  type: 'netlify';
  apiKey: string;
  baseURL?: string;
  proxy?: boolean;
}

export interface VercelProvider extends BaseDeployProvider {
  type: 'vercel';
  apiKey: string;
  baseURL?: string;
  proxy?: boolean;
}

export interface NsiteProvider extends BaseDeployProvider {
  type: 'nsite';
  gateway: string;
  relayUrls: string[];
  blossomServers: string[];
}

export interface CloudflareProvider extends BaseDeployProvider {
  type: 'cloudflare';
  apiKey: string;
  accountId: string;
  baseURL?: string;
  baseDomain?: string;
  proxy?: boolean;
}

export interface DenoDeployProvider extends BaseDeployProvider {
  type: 'deno';
  apiKey: string;
  organizationId: string;
  baseURL?: string;
  baseDomain?: string;
  proxy?: boolean;
}

export interface RailwayProvider extends BaseDeployProvider {
  type: 'railway';
  apiKey: string;
  baseURL?: string;
  proxy?: boolean;
}

export type DeployProvider = NpanelProvider | NetlifyProvider | VercelProvider | NsiteProvider | CloudflareProvider | DenoDeployProvider | RailwayProvider;

export interface DeploySettings {
  providers: DeployProvider[];
}

export interface DeploySettingsContextType {
  settings: DeploySettings;
  updateSettings: (settings: Partial<DeploySettings>) => void;
  removeProvider: (index: number) => void;
  setProviders: (providers: DeployProvider[]) => void;
  isConfigured: boolean;
  isInitialized: boolean;
}

export const DeploySettingsContext = createContext<DeploySettingsContextType | undefined>(undefined);
