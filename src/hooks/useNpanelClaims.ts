import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { NpanelProvider } from '@/contexts/DeploySettingsContext';
import {
  fetchNpanelClaimCount,
  fetchNpanelClaims,
  type NpanelClaim,
  type NpanelClaimCount,
} from '@/lib/deploy/npanelApi';
import {
  NAMED_SITE_KIND,
  hasArchiveTitle,
  isServableHostname,
  manifestIdentifier,
  planClaim,
  type MigrationStep,
} from '@/lib/deploy/npanelMigration';

/** How long the relay round trip for one's own sites is given. */
const RELAY_TIMEOUT_MS = 6_000;

/** A waiting name, with what it would take to get it back. */
export interface NpanelClaimPlan extends NpanelClaim {
  step: MigrationStep;
}

/** A name already taken back, and the event currently serving it. */
export interface NpanelTakenSite {
  hostname: string;
  /** The claimant's own manifest, as relays hold it right now. */
  event: NostrEvent;
  /** What the site calls itself, per the gateway. Null when it never said. */
  suggestedTitle: string | null;
  suggestedDescription: string | null;
  /** Whether the event is still titled after its hostname. */
  needsTitle: boolean;
  /** A name no certificate can cover, which should never have been published. */
  stray: boolean;
}

export interface NpanelClaims {
  /** Names still waiting, each with a plan. */
  waiting: NpanelClaimPlan[];
  /** Names already taken back whose manifest could be improved or removed. */
  taken: NpanelTakenSite[];
  /** Every event of the user's this query saw, for checking relay coverage. */
  events: NostrEvent[];
}

/** The `identifier` half of a `kind:pubkey:identifier` address. */
function addressIdentifier(address: string): string {
  return address.split(':').slice(2).join(':');
}

/** The `d` tag of an event, which for a named site is the site's identifier. */
function eventIdentifier(event: NostrEvent): string {
  return event.tags.find(([name]) => name === 'd')?.[1] ?? '';
}

/**
 * The names waiting for the logged-in user on a gateway, and what each needs.
 *
 * Half the answer comes from relays rather than the gateway: to know whether a
 * name can simply be repointed, one has to know which sites this user already
 * publishes, and that is on the network, not in npanel. The same query answers
 * two more questions at no extra cost — which taken names are still titled
 * after their hostname, and which of them should never have been published at
 * all — so it is made once and its events are kept.
 */
export function useNpanelClaims(provider: NpanelProvider | undefined) {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();

  return useQuery<NpanelClaims>({
    queryKey: ['npanel-claims', provider?.dashboardHost, user?.pubkey],
    enabled: Boolean(provider && user),
    // Nobody's list of waiting names changes on its own, and every refetch
    // costs a signature — which on a remote signer costs a round trip.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const empty: NpanelClaims = { waiting: [], taken: [], events: [] };
      if (!provider || !user) return empty;

      const claims = await fetchNpanelClaims(provider.dashboardHost, user.signer, signal, { taken: true });
      if (!claims.length) return empty;

      // Only the names actually in play are asked about, rather than every
      // site this key has ever published.
      const wanted = new Set<string>();
      for (const claim of claims) {
        const identifier = claim.manifest ? manifestIdentifier(claim.manifest) : '';
        if (identifier) wanted.add(identifier);
        if (claim.address) wanted.add(addressIdentifier(claim.address));
      }
      wanted.delete('');

      const events = wanted.size
        ? await nostr.group(provider.relayUrls).query(
          [{ kinds: [NAMED_SITE_KIND], authors: [user.pubkey], '#d': [...wanted] }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]) },
        )
        : [];

      const byIdentifier = new Map<string, NostrEvent>();
      for (const event of events) {
        const identifier = eventIdentifier(event);
        if (!identifier) continue;
        const seen = byIdentifier.get(identifier);
        if (!seen || seen.created_at < event.created_at) byIdentifier.set(identifier, event);
      }
      const published = new Set(byIdentifier.keys());

      // A name npanel serves from this user's own key is a site this user
      // published, so relays that know nothing about any of them are relays
      // that are not answering. Planning against that silence would mean
      // republishing over live sites, so it fails loudly instead.
      const known = claims
        .filter((claim) => claim.mine && claim.address)
        .map((claim) => addressIdentifier(claim.address ?? ''))
        .filter(Boolean);

      if (known.length && !known.some((identifier) => published.has(identifier))) {
        throw new Error(
          'Relays did not answer with the sites you already publish, so it is not safe to work out what needs republishing. Try again in a moment.',
        );
      }

      const waiting: NpanelClaimPlan[] = [];
      const taken: NpanelTakenSite[] = [];

      for (const claim of claims) {
        if (!claim.claimed) {
          waiting.push({ ...claim, step: planClaim(claim, user.pubkey, published, provider.domain) });
          continue;
        }

        const identifier = claim.address ? addressIdentifier(claim.address) : '';
        const event = identifier ? byIdentifier.get(identifier) : undefined;
        // A claimed name whose event no relay answered with is not a name with
        // nothing wrong; it is a name nothing can be said about. Leaving it out
        // is the only option that cannot make it worse.
        if (!event) continue;

        const stray = !isServableHostname(claim.hostname, provider.domain);

        taken.push({
          hostname: claim.hostname,
          event,
          suggestedTitle: claim.suggestedTitle ?? null,
          suggestedDescription: claim.suggestedDescription ?? null,
          needsTitle: hasArchiveTitle(event, claim.hostname),
          stray,
        });
      }

      return { waiting, taken, events: [...byIdentifier.values()] };
    },
  });
}

/**
 * How many names a gateway is holding for the logged-in user.
 *
 * Separate from {@link useNpanelClaims} because it is asked at a different
 * moment and must cost a different amount. That one runs when somebody opens
 * the dialog and has already decided to look; it reads every claimed deploy on
 * the gateway and queries relays for this user's own events. This one runs
 * because a settings page was opened, so it is one signature and two counted
 * rows, and a gateway that cannot answer it says nothing rather than failing.
 */
export function useNpanelClaimCount(provider: NpanelProvider | undefined) {
  const { user } = useCurrentUser();

  return useQuery<NpanelClaimCount>({
    queryKey: ['npanel-claim-count', provider?.dashboardHost, user?.pubkey],
    enabled: Boolean(provider && user),
    // Nobody's list of waiting names changes on its own, and every refetch
    // costs a signature — which on a remote signer costs a round trip. Long
    // enough that opening settings twice in a sitting asks once.
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!provider || !user) return { waiting: 0, taken: 0 };
      return await fetchNpanelClaimCount(provider.dashboardHost, user.signer, signal);
    },
  });
}
