import type { NostrEvent } from '@nostrify/nostrify';
import type { NpanelClaim, NpanelClaimManifest } from './npanelApi';

/** nsite named-site kind. Everything a gateway archived is one of these. */
export const NAMED_SITE_KIND = 35128;

/**
 * Tags the archive wrote about itself, which are not the site's to carry.
 *
 * The title it invented was the hostname, because that was all it knew, and the
 * `alt` it wrote says the site is archived so that it keeps working — a true
 * sentence about the archive that stops being true the moment its owner takes
 * the name back.
 */
const ARCHIVE_TAGS = new Set(['title', 'description', 'alt']);

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

/** What a site calls itself, when it says. */
export interface SiteIdentity {
  title?: string | null;
  description?: string | null;
}

/** The `d` tag of a manifest, which for a named site is the site's identifier. */
export function manifestIdentifier(manifest: NpanelClaimManifest): string {
  return manifest.tags.find(([name]) => name === 'd')?.[1] ?? '';
}

/**
 * Whether a hostname is one label under the gateway's domain.
 *
 * The wildcard certificate a gateway serves covers exactly one label, so
 * `a.b.example.com` can be pointed at a site, claimed, and published for, and
 * will still fail its TLS handshake for everyone forever. The records exist
 * because the host this migration inherits from accepted them; there is no
 * point signing anything for one.
 */
export function isServableHostname(hostname: string, domain: string): boolean {
  const suffix = `.${domain.toLowerCase()}`;
  const name = hostname.toLowerCase();

  if (!name.endsWith(suffix)) return false;

  const label = name.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
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
  domain: string,
): MigrationStep {
  if (!isServableHostname(claim.hostname, domain)) {
    return {
      kind: 'blocked',
      reason: `No certificate covers a name this deep under ${domain}, so it can never load.`,
    };
  }

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
 * What is not carried over is the archive's own writing. It titled every site
 * after its hostname, which is an address wearing a name's clothes; the site's
 * real name, where it has one, is `identity`. A site that never said what it is
 * called gets no title, which is what an nsite manifest without one has always
 * meant and is more honest than a domain.
 *
 * Relay hints are replaced for the same reason: the archive's say where the
 * archive published, and this event is going somewhere else.
 */
export function republishTags(
  manifest: NpanelClaimManifest,
  identifier: string,
  relayUrls: string[],
  identity: SiteIdentity = {},
): string[][] {
  const kept = manifest.tags.filter(
    ([name]) => name !== 'd' && name !== 'relay' && name !== 'r' && !ARCHIVE_TAGS.has(name),
  );

  return [
    // First, as an addressable event's `d` tag should be.
    ['d', identifier],
    ...kept,
    ...describeTags(identity),
    ...relayUrls.map((url) => ['relay', url]),
  ];
}

/**
 * The same event, with the name the site chose in place of the one it was given.
 *
 * Built from the event as it stands rather than from anything the gateway
 * holds, because the two are not always the same thing: a site republished by
 * this migration and then redeployed normally has moved on, and rebuilding it
 * out of the gateway's copy would quietly restore an older version of the site.
 * Everything but the archive's own words is passed through untouched.
 */
export function retitleTags(event: NostrEvent, identity: SiteIdentity): string[][] {
  return [...event.tags.filter(([name]) => !ARCHIVE_TAGS.has(name)), ...describeTags(identity)];
}

/**
 * Whether an event is still wearing the title the archive gave it.
 *
 * The archive had one thing to call a site it had only ever seen at an address,
 * so a title that is the hostname is a title nobody chose.
 */
export function hasArchiveTitle(event: NostrEvent, hostname: string): boolean {
  const title = event.tags.find(([name]) => name === 'title')?.[1];
  return typeof title === 'string' && title.toLowerCase() === hostname.toLowerCase();
}

/** `title` and `description` tags, for whichever of them the site supplied. */
function describeTags(identity: SiteIdentity): string[][] {
  const tags: string[][] = [];
  if (identity.title) tags.push(['title', identity.title]);
  if (identity.description) tags.push(['description', identity.description]);
  return tags;
}
