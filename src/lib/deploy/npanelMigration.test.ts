import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import type { NpanelClaim } from './npanelApi';
import {
  NAMED_SITE_KIND,
  hasArchiveTitle,
  isServableHostname,
  planClaim,
  republishTags,
  retitleTags,
} from './npanelMigration';

const PUBKEY = 'a'.repeat(64);
const ARCHIVE = 'b'.repeat(64);
const DOMAIN = 'shakespeare.wtf';

function claim(overrides: Partial<NpanelClaim> = {}): NpanelClaim {
  return {
    hostname: 'mysite.shakespeare.wtf',
    source: 'picohost',
    live: true,
    address: `${NAMED_SITE_KIND}:${ARCHIVE}:mysite`,
    mine: false,
    manifest: {
      kind: NAMED_SITE_KIND,
      content: '',
      tags: [
        ['d', 'mysite'],
        ['title', 'mysite.shakespeare.wtf'],
        ['alt', 'mysite.shakespeare.wtf — archived so that it keeps working.'],
        ['path', '/index.html', 'c'.repeat(64)],
        ['server', 'https://blossom.ditto.pub/'],
      ],
    },
    ...overrides,
  };
}

describe('planClaim', () => {
  it('only changes the record for a site already on the owner’s key', () => {
    const address = `${NAMED_SITE_KIND}:${PUBKEY}:mysite`;

    expect(
      planClaim(claim({ mine: true, address, manifest: null }), PUBKEY, new Set(), DOMAIN),
    ).toEqual({ kind: 'claim', address, reason: 'mine' });
  });

  it('points a name at a site the owner already publishes, rather than republishing over it', () => {
    // The destructive case: kind 35128 is addressable, so publishing the
    // archive's stale copy at this `d` tag would replace the live site.
    expect(planClaim(claim(), PUBKEY, new Set(['mysite']), DOMAIN)).toEqual({
      kind: 'claim',
      address: `${NAMED_SITE_KIND}:${PUBKEY}:mysite`,
      reason: 'published',
    });
  });

  it('republishes the archived manifest when nothing is published under that name', () => {
    const step = planClaim(claim(), PUBKEY, new Set(['something-else']), DOMAIN);

    expect(step.kind).toBe('republish');
    expect(step).toMatchObject({ identifier: 'mysite' });
  });

  it('refuses a root site, which would replace the owner’s main site', () => {
    const rooted = claim({ manifest: { kind: 15128, content: '', tags: [] } });

    expect(planClaim(rooted, PUBKEY, new Set(), DOMAIN).kind).toBe('blocked');
  });

  it('has nothing to do for a reservation whose site never made it across', () => {
    const empty = claim({ live: false, address: null, manifest: null });

    expect(planClaim(empty, PUBKEY, new Set(), DOMAIN).kind).toBe('blocked');
  });

  it('refuses a name no certificate can cover, however it got on the list', () => {
    // A wildcard covers one label. The host this migration inherits from took
    // these anyway, so five of them are on file and none can serve TLS.
    const deep = claim({ hostname: 'webvoice.shakespeare.wtf.shakespeare.wtf', mine: true });

    const step = planClaim(deep, PUBKEY, new Set(), DOMAIN);
    expect(step.kind).toBe('blocked');
    expect(step).toMatchObject({ reason: expect.stringContaining('certificate') });
  });
});

describe('isServableHostname', () => {
  it('accepts exactly one label under the domain', () => {
    expect(isServableHostname('mysite.shakespeare.wtf', DOMAIN)).toBe(true);
    expect(isServableHostname('My-Site.Shakespeare.WTF', DOMAIN)).toBe(true);
    expect(isServableHostname('a.b.shakespeare.wtf', DOMAIN)).toBe(false);
    expect(isServableHostname('shakespeare.wtf', DOMAIN)).toBe(false);
    expect(isServableHostname('mysite.example.com', DOMAIN)).toBe(false);
  });
});

describe('republishTags', () => {
  it('keeps the files and where to fetch them, and takes the archive’s words', () => {
    const manifest = claim().manifest;
    if (!manifest) throw new Error('fixture has a manifest');

    const tags = republishTags(
      { ...manifest, tags: [...manifest.tags, ['relay', 'wss://gone.example']] },
      'mysite',
      ['wss://relay.ditto.pub'],
      { title: 'My Site', description: 'What it is for.' },
    );

    expect(tags[0]).toEqual(['d', 'mysite']);
    expect(tags).toContainEqual(['path', '/index.html', 'c'.repeat(64)]);
    expect(tags).toContainEqual(['server', 'https://blossom.ditto.pub/']);
    expect(tags).toContainEqual(['relay', 'wss://relay.ditto.pub']);
    expect(tags).not.toContainEqual(['relay', 'wss://gone.example']);
    expect(tags.filter(([name]) => name === 'd')).toHaveLength(1);

    // The archive's title was the hostname and its `alt` says the site is
    // archived, which stops being true the moment it comes home.
    expect(tags).toContainEqual(['title', 'My Site']);
    expect(tags).toContainEqual(['description', 'What it is for.']);
    expect(tags.filter(([name]) => name === 'title')).toHaveLength(1);
    expect(tags.some(([name]) => name === 'alt')).toBe(false);
  });

  it('leaves a site that never said what it is called untitled', () => {
    const manifest = claim().manifest;
    if (!manifest) throw new Error('fixture has a manifest');

    // Roughly a third of these are shells that set their title from JavaScript.
    // No title is what an nsite manifest without one has always meant, and is
    // better than a domain wearing a name's clothes.
    const tags = republishTags(manifest, 'mysite', [], {});

    expect(tags.some(([name]) => name === 'title')).toBe(false);
    expect(tags).toContainEqual(['path', '/index.html', 'c'.repeat(64)]);
  });
});

describe('retitleTags', () => {
  it('swaps the archive’s words and passes everything else through', () => {
    const event = {
      id: 'e'.repeat(64),
      pubkey: PUBKEY,
      kind: NAMED_SITE_KIND,
      created_at: 1,
      content: '',
      sig: '0'.repeat(128),
      tags: [
        ['d', 'mysite'],
        ['title', 'mysite.shakespeare.wtf'],
        ['path', '/index.html', 'c'.repeat(64)],
        ['server', 'https://blossom.ditto.pub/'],
        ['relay', 'wss://relay.ditto.pub'],
      ],
    } as NostrEvent;

    const tags = retitleTags(event, { title: 'My Site' });

    expect(tags).toContainEqual(['d', 'mysite']);
    expect(tags).toContainEqual(['path', '/index.html', 'c'.repeat(64)]);
    // Built from the event as relays hold it, so a site redeployed since this
    // migration ran keeps whatever it has become.
    expect(tags).toContainEqual(['relay', 'wss://relay.ditto.pub']);
    expect(tags).toContainEqual(['title', 'My Site']);
    expect(tags.filter(([name]) => name === 'title')).toHaveLength(1);
  });
});

describe('hasArchiveTitle', () => {
  const event = (title: string) =>
    ({ tags: [['d', 'mysite'], ['title', title]] }) as NostrEvent;

  it('recognises a title that is really an address', () => {
    expect(hasArchiveTitle(event('mysite.shakespeare.wtf'), 'mysite.shakespeare.wtf')).toBe(true);
    expect(hasArchiveTitle(event('My Site'), 'mysite.shakespeare.wtf')).toBe(false);
    expect(hasArchiveTitle({ tags: [] } as unknown as NostrEvent, 'mysite.shakespeare.wtf')).toBe(false);
  });
});
