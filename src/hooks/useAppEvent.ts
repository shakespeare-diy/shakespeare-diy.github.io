import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';

import { useFS } from '@/hooks/useFS';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { DotAI } from '@/lib/DotAI';

interface UseAppEventOptions {
  /** Project working directory (e.g. /projects/<id>) */
  cwd: string;
}

/**
 * Hook to fetch the kind 31990 app event associated with this project.
 * Reads the stored "a" coordinate from .git/shakespeare/app.json,
 * then queries relays for the matching event.
 */
export function useAppEvent({ cwd }: UseAppEventOptions) {
  const { nostr } = useNostr();
  const { fs } = useFS();
  const { user } = useCurrentUser();
  const [aTag, setATag] = useState<string | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  // Read the stored "a" coordinate on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const dotAI = new DotAI(fs, cwd);
        const config = await dotAI.readAppConfig();
        setATag(config?.a ?? null);
      } catch {
        setATag(null);
      } finally {
        setIsLoadingConfig(false);
      }
    };

    loadConfig();
  }, [fs, cwd]);

  // Parse the "a" coordinate into filter components
  const parsed = aTag ? parseATag(aTag) : null;

  const query = useQuery<NostrEvent | null>({
    queryKey: ['app-event', aTag],
    queryFn: async ({ signal }) => {
      if (!parsed) return null;

      const events = await nostr.query(
        [{
          kinds: [parsed.kind],
          authors: [parsed.pubkey],
          '#d': [parsed.dTag],
          limit: 1,
        }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );

      if (events.length === 0) return null;

      // Return the most recent event
      return events.reduce((latest, current) =>
        current.created_at > latest.created_at ? current : latest,
      );
    },
    enabled: !!parsed && !isLoadingConfig,
  });

  return {
    /** The stored "a" coordinate (e.g. "31990:<pubkey>:<d-tag>") */
    aTag,
    /** Set the "a" coordinate (updates local state; caller must persist) */
    setATag,
    /** The fetched kind 31990 event, or null */
    event: query.data ?? null,
    /** Whether the config or event is still loading */
    isLoading: isLoadingConfig || query.isLoading,
    /** Whether there is an existing app event for this project */
    hasApp: !!aTag,
    /** The current user's pubkey */
    userPubkey: user?.pubkey,
    /** Refetch the event from relays */
    refetch: query.refetch,
  };
}

/** Parse a Nostr "a" coordinate string into its components */
function parseATag(a: string): { kind: number; pubkey: string; dTag: string } | null {
  const parts = a.split(':');
  if (parts.length < 3) return null;

  const kind = parseInt(parts[0], 10);
  if (isNaN(kind)) return null;

  const pubkey = parts[1];
  const dTag = parts.slice(2).join(':'); // d-tag may contain colons

  if (!pubkey || dTag === undefined) return null;

  return { kind, pubkey, dTag };
}
