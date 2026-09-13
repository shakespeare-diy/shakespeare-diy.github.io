import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { NpanelProvider } from '@/contexts/DeploySettingsContext';
import { fetchNpanelClaims, type NpanelClaim } from '@/lib/deploy/npanelApi';
import { NAMED_SITE_KIND, planClaim, type MigrationStep } from '@/lib/deploy/npanelMigration';

/** How long the relay round trip for one's own sites is given. */
const RELAY_TIMEOUT_MS = 4_000;

/** A waiting name, with what it would take to get it back. */
export interface NpanelClaimPlan extends NpanelClaim {
  step: MigrationStep;
}

/** The `identifier` half of a `kind:pubkey:identifier` address. */
function addressIdentifier(address: string): string {
  return address.split(':').slice(2).join(':');
}

/**
 * The names waiting for the logged-in user on a gateway, and what each needs.
 *
 * The second half of the answer comes from relays rather than the gateway: to
 * know whether a name can simply be repointed, one has to know which sites this
 * user already publishes, and that is on the network, not in npanel.
 */
export function useNpanelClaims(provider: NpanelProvider | undefined) {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();

  return useQuery<NpanelClaimPlan[]>({
    queryKey: ['npanel-claims', provider?.dashboardHost, user?.pubkey],
    enabled: Boolean(provider && user),
    // Nobody's list of waiting names changes on its own, and every refetch
    // costs a signature — which on a remote signer costs a round trip.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!provider || !user) return [];

      const claims = await fetchNpanelClaims(provider.dashboardHost, user.signer, signal);
      if (!claims.length) return [];

      // Only the names actually in play are asked about, rather than every
      // site this key has ever published.
      const wanted = new Set<string>();
      for (const claim of claims) {
        const identifier = claim.manifest?.tags.find(([name]) => name === 'd')?.[1];
        if (identifier) wanted.add(identifier);
        if (claim.mine && claim.address) wanted.add(addressIdentifier(claim.address));
      }

      const events = wanted.size
        ? await nostr.group(provider.relayUrls).query(
          [{ kinds: [NAMED_SITE_KIND], authors: [user.pubkey], '#d': [...wanted] }],
          { signal: AbortSignal.any([signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]) },
        )
        : [];

      const published = new Set(
        events
          .map((event) => event.tags.find(([name]) => name === 'd')?.[1])
          .filter((identifier): identifier is string => Boolean(identifier)),
      );

      // A name npanel serves from this user's own key is a site this user
      // published, so relays that know nothing about it are relays that are
      // not answering. Planning against that silence would mean republishing
      // over live sites, so it fails loudly instead.
      const known = claims
        .filter((claim) => claim.mine && claim.address)
        .map((claim) => addressIdentifier(claim.address ?? ''))
        .filter(Boolean);

      if (known.length && !known.some((identifier) => published.has(identifier))) {
        throw new Error(
          'Relays did not answer with the sites you already publish, so it is not safe to work out what needs republishing. Try again in a moment.',
        );
      }

      return claims.map((claim) => ({ ...claim, step: planClaim(claim, user.pubkey, published) }));
    },
  });
}
