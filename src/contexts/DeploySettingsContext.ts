import { createContext } from 'react';

export interface BaseDeployProvider {
  id: string;
  name: string;
  proxy?: boolean;
}

export interface ShakespeareDeployProvider extends BaseDeployProvider {
  type: 'shakespeare';
  host?: string;
}

export interface NetlifyProvider extends BaseDeployProvider {
  type: 'netlify';
  apiKey: string;
  baseURL?: string;
}

export interface VercelProvider extends BaseDeployProvider {
  type: 'vercel';
  apiKey: string;
  baseURL?: string;
}

export interface NsiteProvider extends BaseDeployProvider {
  type: 'nsite';
  gateway: string;
  relayUrls: string[];
  blossomServers: string[];
}

export type DeployProvider = ShakespeareDeployProvider | NetlifyProvider | VercelProvider | NsiteProvider;

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
