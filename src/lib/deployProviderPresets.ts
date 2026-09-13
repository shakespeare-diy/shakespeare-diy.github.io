import type { DeployProvider, NpanelProvider, NsiteProvider } from '@/contexts/DeploySettingsContext';
import type { PresetDeployProvider } from './deploy/types';

const DEFAULT_RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.dreamith.to',
  'wss://relay.nsite.lol',
  'wss://relay.nosto.re',
  'wss://relay.primal.net',
];

const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.ditto.pub',
  'https://blossom.dreamith.to',
  'https://blossom.primal.net',
  'https://cdn.sovbit.host',
];

/**
 * Shakespeare's own gateway, which every new user starts with.
 *
 * It serves an ordinary nsite — the site is published under the user's key and
 * readable without this gateway — and adds a name under `shakespeare.wtf`.
 */
export const DEFAULT_NPANEL_PROVIDER: NpanelProvider = {
  id: 'npanel',
  name: 'Shakespeare',
  type: 'npanel',
  dashboardHost: 'npanel.shakespeare.to',
  domain: 'shakespeare.wtf',
  relayUrls: DEFAULT_RELAYS,
  blossomServers: DEFAULT_BLOSSOM_SERVERS,
};

/** Plain nsite, for publishing without any gateway holding a name for you. */
export const DEFAULT_NSITE_PROVIDER: NsiteProvider = {
  id: 'nsite',
  name: 'nsite',
  type: 'nsite',
  gateway: 'shakespeare.to',
  relayUrls: DEFAULT_RELAYS,
  blossomServers: DEFAULT_BLOSSOM_SERVERS,
};

/** What a user who has never opened the deploy settings gets. */
export const DEFAULT_DEPLOY_PROVIDERS: DeployProvider[] = [DEFAULT_NPANEL_PROVIDER];

/**
 * Bring a provider saved by an older version up to date.
 *
 * `shakespeare` was a zip upload to a host that kept the files itself. That host
 * now serves those same domains out of nsite manifests, so the type it maps to
 * is the gateway one — same domain, same name, and the deploy button keeps
 * working without anyone being asked to reconfigure anything.
 *
 * Returns the provider unchanged when there is nothing to do, so this is safe to
 * run over every provider on every load.
 */
export function migrateDeployProvider(provider: unknown): unknown {
  if (typeof provider !== 'object' || provider === null) return provider;

  const candidate = provider as Record<string, unknown>;
  if (candidate.type !== 'shakespeare') return provider;

  const host = typeof candidate.host === 'string' && candidate.host ? candidate.host : 'shakespeare.wtf';

  return {
    id: typeof candidate.id === 'string' ? candidate.id : DEFAULT_NPANEL_PROVIDER.id,
    name: typeof candidate.name === 'string' ? candidate.name : DEFAULT_NPANEL_PROVIDER.name,
    type: 'npanel',
    dashboardHost: DEFAULT_NPANEL_PROVIDER.dashboardHost,
    domain: host,
    relayUrls: DEFAULT_RELAYS,
    blossomServers: DEFAULT_BLOSSOM_SERVERS,
  };
}

export const PRESET_DEPLOY_PROVIDERS: PresetDeployProvider[] = [
  {
    id: 'npanel',
    type: 'npanel',
    name: 'Shakespeare',
    description: 'Publish to Nostr and get a shakespeare.wtf address',
    baseURL: 'https://shakespeare.diy',
    requiresNostr: true,
  },
  {
    id: 'nsite',
    type: 'nsite',
    name: 'nsite',
    description: 'Deploy to Nostr as a static website',
    // No baseURL for nsite - uses Rocket icon fallback
  },
  {
    id: 'netlify',
    type: 'netlify',
    name: 'Netlify',
    description: 'Deploy to Netlify',
    baseURL: 'https://api.netlify.com/api/v1',
    apiKeyLabel: 'Personal Access Token',
    apiKeyURL: 'https://app.netlify.com/user/applications#personal-access-tokens',
    proxy: true,
  },
  {
    id: 'vercel',
    type: 'vercel',
    name: 'Vercel',
    description: 'Deploy to Vercel',
    baseURL: 'https://api.vercel.com',
    apiKeyLabel: 'Access Token',
    apiKeyURL: 'https://vercel.com/account/tokens',
    proxy: true,
  },
  {
    id: 'cloudflare',
    type: 'cloudflare',
    name: 'Cloudflare',
    description: 'Deploy to Cloudflare Workers',
    baseURL: 'https://api.cloudflare.com/client/v4',
    apiKeyLabel: 'API Token',
    apiKeyURL: 'https://dash.cloudflare.com/profile/api-tokens',
    accountIdLabel: 'Account ID',
    accountIdURL: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
    proxy: true,
  },
  {
    id: 'deno',
    type: 'deno',
    name: 'Deno Deploy',
    description: 'Deploy to Deno Deploy',
    baseURL: 'https://api.deno.com/v1',
    apiKeyLabel: 'Access Token',
    apiKeyURL: 'https://dash.deno.com/account#access-tokens',
    organizationIdLabel: 'Organization ID',
    organizationIdURL: 'https://dash.deno.com/orgs',
    proxy: true,
  },
  {
    id: 'railway',
    type: 'railway',
    name: 'Railway',
    description: 'Deploy to Railway',
    baseURL: 'https://backboard.railway.com',
    apiKeyLabel: 'API Token',
    apiKeyURL: 'https://railway.app/account/tokens',
    proxy: true,
  },
];
