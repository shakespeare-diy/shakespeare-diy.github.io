import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrFilter, NRelay, NPool } from '@nostrify/nostrify';
import { useAppContext } from '@/hooks/useAppContext';

export interface AppSubmission extends NostrEvent {
  appName: string;
  websiteUrl: string;
  repositoryUrl: string;
  description: string;
  appIconUrl: string;
}

/**
 * Extract pubkeys from the `p` tags of a Nostr event.
 */
function extractPubkeys(event: NostrEvent): string[] {
  return event.tags
    .filter(([name]) => name === 'p')
    .map(([, pubkey]) => pubkey)
    .filter(Boolean);
}

/**
 * Resolve a NIP-19 identifier (note1, nevent1, or naddr1) to an event.
 */
async function resolveCuratorEvent(
  curatorIdentifier: string,
  nostr: NPool<NRelay>,
): Promise<NostrEvent | null> {
  try {
    const decoded = nip19.decode(curatorIdentifier);

    if (decoded.type === 'note') {
      const events = await nostr.query(
        [{ ids: [decoded.data], limit: 1 }],
        { signal: AbortSignal.timeout(3000) },
      );
      return events[0] ?? null;
    }

    if (decoded.type === 'nevent') {
      const filter: NostrFilter = { ids: [decoded.data.id], limit: 1 };
      if (decoded.data.author) filter.authors = [decoded.data.author];
      const events = await nostr.query([filter], { signal: AbortSignal.timeout(3000) });
      return events[0] ?? null;
    }

    if (decoded.type === 'naddr') {
      const { kind, pubkey, identifier } = decoded.data;
      const events = await nostr.query(
        [{ kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 }],
        { signal: AbortSignal.timeout(3000) },
      );
      return events[0] ?? null;
    }
  } catch {
    // Invalid identifier or query failure — handled by caller
  }

  return null;
}

/**
 * Returns true if a kind 31990 event can render an "Edit with Shakespeare" button.
 * Requires an `a` tag referencing a kind 30617 git repository event.
 */
function hasGitRepository(event: NostrEvent): boolean {
  return event.tags.some(([name, value]) => name === 'a' && value?.startsWith('30617:'));
}

/**
 * Build a git clone URL from a kind 30617 `a` tag value (`30617:pubkey:d-tag`).
 * Returns a nostr:// URI usable with isomorphic-git / Shakespeare clone flow.
 */
function repositoryUrlFromATag(aTagValue: string): string {
  const parts = aTagValue.split(':');
  if (parts.length < 3) return '';
  const [, pubkey, identifier] = parts;
  return `nostr://${pubkey}/${identifier}`;
}

export function useAppSubmissions() {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const curatorIdentifier = config.showcaseCurator;

  return useQuery({
    queryKey: ['nostr', 'app-submissions', curatorIdentifier],
    queryFn: async (): Promise<AppSubmission[]> => {
      // No curator configured — nothing to show
      if (!curatorIdentifier.trim()) return [];

      // 1. Resolve the curator event to extract author pubkeys
      const curatorEvent = await resolveCuratorEvent(curatorIdentifier, nostr);
      if (!curatorEvent) return [];

      const authorPubkeys = extractPubkeys(curatorEvent);
      if (authorPubkeys.length === 0) return [];

      // 2. Query kind 31990 events from those authors tagged with #t:shakespeare
      const appEvents = await nostr.query(
        [{
          kinds: [31990],
          authors: authorPubkeys,
          '#t': ['shakespeare'],
          limit: 200,
        }],
        { signal: AbortSignal.timeout(5000) },
      );

      // 3. Client-side filter: only keep events that can render "Edit with Shakespeare"
      const filteredEvents = appEvents.filter(hasGitRepository);

      // 4. Deduplicate: for each pubkey+d-tag, keep only the latest event
      const latestMap = new Map<string, NostrEvent>();
      for (const event of filteredEvents) {
        const dTag = event.tags.find(([name]) => name === 'd')?.[1] ?? '';
        const key = `${event.pubkey}:${dTag}`;
        const existing = latestMap.get(key);
        if (!existing || event.created_at > existing.created_at) {
          latestMap.set(key, event);
        }
      }

      // 5. Shape into AppSubmission objects
      const submissions: AppSubmission[] = [];
      for (const event of latestMap.values()) {
        try {
          let appName = '';
          let appIconUrl = '';
          let websiteUrl = '';
          let description = '';

          // Parse kind-0-style metadata from content
          if (event.content) {
            try {
              const meta = JSON.parse(event.content) as Record<string, unknown>;
              if (typeof meta.name === 'string') appName = meta.name;
              if (typeof meta.about === 'string') description = meta.about;
              if (typeof meta.picture === 'string') appIconUrl = meta.picture;
              if (typeof meta.website === 'string') websiteUrl = meta.website;
            } catch {
              // Non-JSON content — ignore
            }
          }

          // Fallback: title tag
          if (!appName) {
            appName = event.tags.find(([name]) => name === 'title')?.[1] ?? '';
          }

          // Build repository URL from the first 30617 `a` tag
          const repoATag = event.tags.find(([name, value]) => name === 'a' && value?.startsWith('30617:'));
          const repositoryUrl = repoATag ? repositoryUrlFromATag(repoATag[1]) : '';

          submissions.push({
            ...event,
            appName,
            websiteUrl,
            repositoryUrl,
            description,
            appIconUrl,
          });
        } catch (error) {
          console.warn('Failed to parse app submission:', error);
        }
      }

      return submissions;
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });
}

export function useUserAppSubmissions(userPubkey?: string) {
  const { data: allSubmissions, ...rest } = useAppSubmissions();

  const userSubmissions = allSubmissions?.filter(app => app.pubkey === userPubkey) || [];

  return {
    data: userSubmissions,
    ...rest,
  };
}
