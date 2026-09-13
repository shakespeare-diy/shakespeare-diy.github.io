import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { AlertCircle, Check, ExternalLink, Loader2, Rocket, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNpanelClaims, type NpanelClaimPlan, type NpanelTakenSite } from '@/hooks/useNpanelClaims';
import type { NpanelProvider } from '@/contexts/DeploySettingsContext';
import { claimNpanelHostname } from '@/lib/deploy/npanelApi';
import { NAMED_SITE_KIND, republishTags, retitleTags } from '@/lib/deploy/npanelMigration';
import { checkRelayCoverage, forwardMissing, host, publishToRelays } from '@/lib/deploy/publishToRelays';

/** Where a single name has got to. */
type RowStatus =
  | { kind: 'waiting' }
  | { kind: 'publishing' }
  | { kind: 'claiming' }
  | { kind: 'done'; partial?: string }
  | { kind: 'failed'; error: string };

/** What the last coverage run found, as a sentence per relay. */
interface CoverageReport {
  lines: string[];
}

interface NpanelMigrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: NpanelProvider;
}

function describeStep(claim: NpanelClaimPlan): string {
  switch (claim.step.kind) {
    case 'claim':
      return claim.step.reason === 'mine'
        ? 'Already published under your key — only the record changes.'
        : 'You already publish a site under this name; the address will point at it.';
    case 'republish':
      return 'A copy will be published under your key, then the name repointed.';
    case 'blocked':
      return claim.step.reason;
  }
}

/** "took 3 of 5 relays", where that is worth saying. */
function coverageNote(accepted: string[], rejected: { url: string; reason: string }[]): string | undefined {
  if (!rejected.length) return undefined;
  const total = accepted.length + rejected.length;
  return `${accepted.length} of ${total} relays took it — ${host(rejected[0].url)}: ${rejected[0].reason}`;
}

export function NpanelMigrationDialog({ open, onOpenChange, provider }: NpanelMigrationDialogProps) {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useNpanelClaims(open ? provider : undefined);

  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [running, setRunning] = useState<null | 'migrate' | 'titles' | 'coverage'>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);

  const claims = data?.waiting ?? [];
  const actionable = claims.filter((claim) => claim.step.kind !== 'blocked');
  const blocked = claims.filter((claim) => claim.step.kind === 'blocked');

  const retitlable = (data?.taken ?? []).filter((site) => site.needsTitle && !site.stray);
  const strays = (data?.taken ?? []).filter((site) => site.stray);

  const done = Object.values(statuses).filter((status) => status.kind === 'done').length;
  const failed = Object.values(statuses).filter((status) => status.kind === 'failed').length;

  const setStatus = (hostname: string, status: RowStatus) => {
    setStatuses((previous) => ({ ...previous, [hostname]: status }));
  };

  /**
   * Take back one name.
   *
   * Publish before claiming, always: a hostname pointed at an event the gateway
   * has never seen serves nothing until it catches up, and the order that gap
   * is smallest in is this one.
   */
  const migrate = async (claim: NpanelClaimPlan): Promise<void> => {
    if (!user || claim.step.kind === 'blocked') return;

    let address: string;
    let note: string | undefined;

    if (claim.step.kind === 'republish') {
      setStatus(claim.hostname, { kind: 'publishing' });

      const event = await user.signer.signEvent({
        kind: NAMED_SITE_KIND,
        content: claim.step.manifest.content,
        created_at: Math.floor(Date.now() / 1000),
        tags: republishTags(claim.step.manifest, claim.step.identifier, provider.relayUrls, {
          title: claim.suggestedTitle,
          description: claim.suggestedDescription,
        }),
      });

      const published = await publishToRelays(nostr, event, provider.relayUrls);
      note = coverageNote(published.accepted, published.rejected);

      address = `${NAMED_SITE_KIND}:${user.pubkey}:${claim.step.identifier}`;
    } else {
      address = claim.step.address;
    }

    setStatus(claim.hostname, { kind: 'claiming' });
    await claimNpanelHostname(provider.dashboardHost, user.signer, claim.hostname, address);
    setStatus(claim.hostname, { kind: 'done', partial: note });
  };

  /** Republish one already-claimed site under the name it chose for itself. */
  const retitle = async (site: NpanelTakenSite): Promise<void> => {
    if (!user) return;

    setStatus(site.hostname, { kind: 'publishing' });

    const event = await user.signer.signEvent({
      kind: site.event.kind,
      content: site.event.content,
      created_at: Math.floor(Date.now() / 1000),
      tags: retitleTags(site.event, {
        title: site.suggestedTitle,
        description: site.suggestedDescription,
      }),
    });

    const published = await publishToRelays(nostr, event, provider.relayUrls);
    setStatus(site.hostname, {
      kind: 'done',
      partial: coverageNote(published.accepted, published.rejected),
    });
  };

  /** Ask a relay to forget a manifest that was published for an unusable name. */
  const removeStray = async (site: NpanelTakenSite): Promise<void> => {
    if (!user) return;

    setStatus(site.hostname, { kind: 'publishing' });

    try {
      const identifier = site.event.tags.find(([name]) => name === 'd')?.[1] ?? '';
      const deletion = await user.signer.signEvent({
        kind: 5,
        content: 'Published for a hostname no certificate can cover.',
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', site.event.id],
          ['a', `${site.event.kind}:${user.pubkey}:${identifier}`],
          ['k', String(site.event.kind)],
        ],
      });

      await publishToRelays(nostr, deletion, provider.relayUrls);
      setStatus(site.hostname, { kind: 'done' });
    } catch (err) {
      setStatus(site.hostname, {
        kind: 'failed',
        error: err instanceof Error ? err.message : 'Failed',
      });
    }
  };

  /** Run `action` over `rows`, one at a time, recording failures per row. */
  const runEach = async <T,>(
    rows: T[],
    key: (row: T) => string,
    action: (row: T) => Promise<void>,
  ): Promise<void> => {
    for (const row of rows) {
      if (statuses[key(row)]?.kind === 'done') continue;

      try {
        await action(row);
      } catch (err) {
        setStatus(key(row), {
          kind: 'failed',
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }
  };

  const migrateAll = async () => {
    setRunning('migrate');
    // One at a time: a remote signer answers one request at a time anyway, and
    // a failure halfway through should leave a list somebody can read rather
    // than a hundred simultaneous errors.
    await runEach(actionable, (claim) => claim.hostname, migrate);
    setRunning(null);
    // Whatever succeeded is no longer waiting, and whatever failed still is.
    queryClient.invalidateQueries({ queryKey: ['npanel-claims'] });
  };

  const fixTitles = async () => {
    setRunning('titles');
    await runEach(retitlable, (site) => site.hostname, retitle);
    setRunning(null);
    queryClient.invalidateQueries({ queryKey: ['npanel-claims'] });
  };

  /**
   * Fill in the relays that are missing these manifests.
   *
   * Costs no signatures: the events go out exactly as they are, ids and
   * signatures unchanged, so a relay that already has one says `duplicate:`
   * and a relay that refused before says why.
   */
  const fixCoverage = async () => {
    const events = data?.events ?? [];
    if (!events.length) return;

    setRunning('coverage');
    setCoverage(null);

    try {
      const found = await checkRelayCoverage(
        nostr,
        provider.relayUrls,
        events.map((event) => event.id),
      );
      const result = await forwardMissing(nostr, found, events);

      const lines = found.map((relay) => {
        const had = relay.present.size;
        const sent = result.filled.get(relay.url) ?? 0;
        const why = result.refused.get(relay.url);

        if (why) return `${host(relay.url)}: had ${had} of ${events.length}, refused the rest — ${why}`;
        if (sent) return `${host(relay.url)}: had ${had} of ${events.length}, sent ${sent} more`;
        return `${host(relay.url)}: has all ${events.length}`;
      });

      setCoverage({ lines });
    } catch (err) {
      setCoverage({ lines: [err instanceof Error ? err.message : 'Could not check relay coverage.'] });
    }

    setRunning(null);
  };

  const renderStatus = (hostname: string, fallback: string) => {
    const status = statuses[hostname] ?? { kind: 'waiting' as const };

    switch (status.kind) {
      case 'publishing':
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Publishing…
          </span>
        );
      case 'claiming':
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Claiming…
          </span>
        );
      case 'done':
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="h-3 w-3 shrink-0" />
            {status.partial ? (
              <span>{status.partial}</span>
            ) : (
              <a
                href={`https://${hostname}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 hover:text-foreground"
              >
                Yours <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </span>
        );
      case 'failed':
        return <span className="text-xs text-destructive">{status.error}</span>;
      case 'waiting':
        return <span className="text-xs text-muted-foreground">{fallback}</span>;
    }
  };

  const busy = running !== null;

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Take back your sites</DialogTitle>
          <DialogDescription>
            These names on {provider.domain} were yours before this gateway took the domain over.
            They are being served from an archive key until you publish your own copy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 py-2">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}

          {data && !claims.length && !data.taken.length && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Nothing is waiting for you here.
            </p>
          )}

          {actionable.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Waiting for you</h4>
              <div className="rounded-md border divide-y">
                {actionable.map((claim) => (
                  <div key={claim.hostname} className="flex items-center justify-between gap-4 p-3">
                    <div className="min-w-0">
                      <div className="font-mono text-sm truncate">{claim.hostname}</div>
                      <div className="truncate">{renderStatus(claim.hostname, describeStep(claim))}</div>
                    </div>
                    <span className="shrink-0 text-xs rounded-full px-2 py-0.5 border text-muted-foreground">
                      {claim.step.kind === 'republish' ? 'republish' : 'claim'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {retitlable.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium">Titled after their address</h4>
                  <p className="text-xs text-muted-foreground">
                    The archive could only call a site by its hostname. These say what they are
                    actually called, so the name they publish under can too.
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={fixTitles} disabled={busy}>
                  {running === 'titles' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fix titles'}
                </Button>
              </div>
              <div className="rounded-md border divide-y">
                {retitlable.map((site) => (
                  <div key={site.hostname} className="flex items-center justify-between gap-4 p-3">
                    <div className="min-w-0">
                      <div className="font-mono text-sm truncate">{site.hostname}</div>
                      <div className="truncate">
                        {renderStatus(
                          site.hostname,
                          site.suggestedTitle ? `Will be titled "${site.suggestedTitle}".` : 'The title will be removed.',
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(data?.events.length ?? 0) > 0 && (
            <div className="space-y-2">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium">Relay coverage</h4>
                  <p className="text-xs text-muted-foreground">
                    A site is only as findable as the relays holding its manifest. This sends the
                    events you already published to the relays that do not have them — same events,
                    no signing.
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={fixCoverage} disabled={busy}>
                  {running === 'coverage' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Check relays'}
                </Button>
              </div>
              {coverage && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                  {coverage.lines.map((line) => (
                    <p key={line} className="text-xs font-mono text-muted-foreground break-words">
                      {line}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {strays.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Published for a name that cannot load</h4>
              <div className="rounded-md border border-dashed divide-y">
                {strays.map((site) => (
                  <div key={site.hostname} className="flex items-center justify-between gap-4 p-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-mono text-sm truncate">{site.hostname}</div>
                      <div className="truncate">
                        {renderStatus(
                          site.hostname,
                          `No certificate covers a name this deep under ${provider.domain}.`,
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => removeStray(site)}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4 mr-1.5" />
                      Retract
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {blocked.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Needs a decision</h4>
              <div className="rounded-md border border-dashed divide-y">
                {blocked.map((claim) => (
                  <div key={claim.hostname} className="p-3 space-y-0.5">
                    <div className="font-mono text-sm truncate">{claim.hostname}</div>
                    <p className="text-xs text-muted-foreground">{describeStep(claim)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:justify-between items-center">
          <span className="text-xs text-muted-foreground">
            {failed > 0
              ? `${done} done, ${failed} failed — run it again to retry.`
              : done > 0
                ? `${done} done. A republished site takes the gateway about a minute to pick up.`
                : `${actionable.length} to migrate.`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Close
            </Button>
            <Button onClick={migrateAll} disabled={busy || actionable.length === 0}>
              {running === 'migrate' ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Migrating…
                </>
              ) : (
                <>
                  <Rocket className="h-4 w-4 mr-2" />
                  {failed > 0 ? 'Retry' : `Migrate all (${actionable.length})`}
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
