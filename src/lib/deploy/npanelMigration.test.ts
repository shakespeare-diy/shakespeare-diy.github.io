import { describe, it, expect } from 'vitest';
import type { NpanelClaim } from './npanelApi';
import { NAMED_SITE_KIND, planClaim, republishTags } from './npanelMigration';

const PUBKEY = 'a'.repeat(64);
const ARCHIVE = 'b'.repeat(64);

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

    expect(planClaim(claim({ mine: true, address, manifest: null }), PUBKEY, new Set())).toEqual({
      kind: 'claim',
      address,
      reason: 'mine',
    });
  });

  it('points a name at a site the owner already publishes, rather than republishing over it', () => {
    // The destructive case: kind 35128 is addressable, so publishing the
    // archive's stale copy at this `d` tag would replace the live site.
    expect(planClaim(claim(), PUBKEY, new Set(['mysite']))).toEqual({
      kind: 'claim',
      address: `${NAMED_SITE_KIND}:${PUBKEY}:mysite`,
      reason: 'published',
    });
  });

  it('republishes the archived manifest when nothing is published under that name', () => {
    const step = planClaim(claim(), PUBKEY, new Set(['something-else']));

    expect(step.kind).toBe('republish');
    expect(step).toMatchObject({ identifier: 'mysite' });
  });

  it('refuses a root site, which would replace the owner’s main site', () => {
    const rooted = claim({ manifest: { kind: 15128, content: '', tags: [] } });

    expect(planClaim(rooted, PUBKEY, new Set()).kind).toBe('blocked');
  });

  it('has nothing to do for a reservation whose site never made it across', () => {
    const empty = claim({ live: false, address: null, manifest: null });

    expect(planClaim(empty, PUBKEY, new Set()).kind).toBe('blocked');
  });
});

describe('republishTags', () => {
  it('keeps the files and where to fetch them, and takes the relay hints', () => {
    const manifest = claim().manifest;
    if (!manifest) throw new Error('fixture has a manifest');

    const tags = republishTags(
      { ...manifest, tags: [...manifest.tags, ['relay', 'wss://gone.example']] },
      'mysite',
      ['wss://relay.ditto.pub'],
    );

    expect(tags[0]).toEqual(['d', 'mysite']);
    expect(tags).toContainEqual(['path', '/index.html', 'c'.repeat(64)]);
    expect(tags).toContainEqual(['server', 'https://blossom.ditto.pub/']);
    expect(tags).toContainEqual(['relay', 'wss://relay.ditto.pub']);
    expect(tags).not.toContainEqual(['relay', 'wss://gone.example']);
    expect(tags.filter(([name]) => name === 'd')).toHaveLength(1);
  });
});
