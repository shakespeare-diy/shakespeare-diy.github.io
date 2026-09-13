import type { NpanelClaim, NpanelClaimManifest } from './npanelApi';

/** nsite named-site kind. Everything a gateway archived is one of these. */
export const NAMED_SITE_KIND = 35128;

/**
 * What taking one name back requires.
 *
 * Three outcomes rather than two, because the interesting case is the one in
 * the middle: a name whose site is already published under the claimant's own
 * key needs no republishing at all, and republishing it anyway would overwrite
 * a live site with an old snapshot of itself.
 */
export type MigrationStep =
  /** Point the name at a site that already exists. Costs one request. */
  | { kind: 'claim'; address: string; reason: 'mine' | 'published' }
  /** Publish the archived manifest under the claimant's key, then point at it. */
  | { kind: 'republish'; identifier: string; manifest: NpanelClaimManifest }
  /** Nothing safe to do without a person deciding something first. */
  | { kind: 'blocked'; reason: string };

/** The `d` tag of a manifest, which for a named site is the site's identifier. */
export function manifestIdentifier(manifest: NpanelClaimManifest): string {
  return manifest.tags.find(([name]) => name === 'd')?.[1] ?? '';
}

/**
 * Decide how a single waiting name gets back to its owner.
 *
 * `published` is the set of `d` tags the owner already publishes kind-35128
 * events under. It is what separates a name that only needs a record changed
 * from one that needs a site published, and getting it wrong in the careless
 * direction destroys a live site: kind 35128 is addressable, so a second event
 * at the same `d` tag replaces the first one everywhere.
 */
export function planClaim(
  claim: NpanelClaim,
  pubkey: string,
  published: ReadonlySet<string>,
): MigrationStep {
  // Already on their key — the site was never anyone else's, only the record
  // of who owns the name was missing.
  if (claim.mine && claim.address) {
    return { kind: 'claim', address: claim.address, reason: 'mine' };
  }

  if (!claim.manifest) {
    return {
      kind: 'blocked',
      reason: 'Nothing was archived under this name. Deploy a project to it to take it back.',
    };
  }

  // A root site is the one site a key can only have one of. Republishing an
  // archived copy as one would replace whatever the claimant's own key serves.
  if (claim.manifest.kind !== NAMED_SITE_KIND) {
    return {
      kind: 'blocked',
      reason: 'This name was archived as a root site, which would replace your main site if republished.',
    };
  }

  const identifier = manifestIdentifier(claim.manifest);
  if (!identifier) {
    return { kind: 'blocked', reason: 'The archived site has no name to publish it under.' };
  }

  // The site is already theirs under this name; the hostname just needs to be
  // told about it. Both names then serve the same site, which is what someone
  // who deployed the same project twice was always asking for.
  if (published.has(identifier)) {
    return {
      kind: 'claim',
      address: `${NAMED_SITE_KIND}:${pubkey}:${identifier}`,
      reason: 'published',
    };
  }

  return { kind: 'republish', identifier, manifest: claim.manifest };
}

/**
 * The tags to sign to republish an archived site under one's own key.
 *
 * An nsite manifest is its tags — the paths and their hashes, and the Blossom
 * servers those hashes can be fetched from — so signing these again produces
 * the same site, file for file, under a different key. The blobs themselves are
 * addressed by hash and are already where the `server` tags say they are, so
 * nothing has to be uploaded.
 *
 * Relay hints are replaced rather than kept: the archive's, if it had any, say
 * where the archive published, and this event is going somewhere else.
 */
export function republishTags(
  manifest: NpanelClaimManifest,
  identifier: string,
  relayUrls: string[],
): string[][] {
  const kept = manifest.tags.filter(([name]) => name !== 'd' && name !== 'relay' && name !== 'r');

  return [
    // First, as an addressable event's `d` tag should be.
    ['d', identifier],
    ...kept,
    ...relayUrls.map((url) => ['relay', url]),
  ];
}
