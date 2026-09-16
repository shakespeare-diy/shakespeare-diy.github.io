import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { AlertCircle, Check, ExternalLink, Eye, Loader2, Rocket, Tag, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNpanelClaims, type NpanelClaimPlan, type NpanelTakenSite } from '@/hooks/useNpanelClaims';
import type { NpanelProvider } from '@/contexts/DeploySettingsContext';
import { claimNpanelHostname, deleteNpanelClaim } from '@/lib/deploy/npanelApi';
import {
  NAMED_SITE_KIND,
  nsitePreviewUrl,
  republishTags,
  retitleTags,
  sitePreviewUrl,
} from '@/lib/deploy/npanelMigration';
import { checkRelayCoverage, forwardMissing, host, publishToRelays } from '@/lib/deploy/publishToRelays';

/** Where a single name has got to. */
type RowStatus =
  | { kind: 'waiting' }
  | { kind: 'publishing' }
  | { kind: 'claiming' }
  | { kind: 'deleting' }
  | { kind: 'deleted'; note?: string }
  | { kind: 'done'; partial?: string }
  | { kind: 'failed'; error: string };

/** A name a person has asked to delete, and has not confirmed yet. */
interface PendingDeletion {
  hostname: string;
  /** Whether a copy of the site is published under their own key. */
  published: boolean;
}

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

/** The `d` tag of an event, which for a named site is the site's identifier. */
function eventIdentifier(event: NostrEvent): string {
  return event.tags.find(([name]) => name === 'd')?.[1] ?? '';
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
  const [running, setRunning] = useState<null | 'migrate' | 'titles' | 'coverage' | 'row'>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [confirming, setConfirming] = useState<PendingDeletion | null>(null);
  /** Whether anything has happened that the cached lists do not know about. */
  const [dirty, setDirty] = useState(false);

  const claims = data?.waiting ?? [];
  const actionable = claims.filter((claim) => claim.step.kind !== 'blocked');
  const blocked = claims.filter((claim) => claim.step.kind === 'blocked');

  const retitlable = (data?.taken ?? []).filter((site) => site.needsTitle && !site.stray);
  const strays = (data?.taken ?? []).filter((site) => site.stray);

  const done = Object.values(statuses).filter((status) => status.kind === 'done').length;
  const deleted = Object.values(statuses).filter((status) => status.kind === 'deleted').length;
  const failed = Object.values(statuses).filter((status) => status.kind === 'failed').length;

  const setStatus = (hostname: string, status: RowStatus) => {
    setStatuses((previous) => ({ ...previous, [hostname]: status }));
  };

  /** Whether a row has already reached a state no further action applies to. */
  const settled = (hostname: string): boolean => {
    const kind = statuses[hostname]?.kind;
    return kind === 'done' || kind === 'deleted';
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
        tags: republishTags(claim.step.manifest, claim.step.identifier, {
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

  /**
   * Give a name up rather than take it back.
   *
   * Only npanel forgets anything. The archive's manifest stays on relays under
   * the archive's key, and a copy published under the user's own key stays
   * theirs — what ends is this gateway serving the name and holding it for
   * them. Saying otherwise in the confirmation would be a promise nothing here
   * can keep.
   */
  const removeClaim = async (hostname: string): Promise<void> => {
    if (!user) return;

    setStatus(hostname, { kind: 'deleting' });
    await deleteNpanelClaim(provider.dashboardHost, user.signer, hostname);
    setStatus(hostname, { kind: 'deleted' });
  };

  /**
   * Undo a manifest published for a name that can never load.
   *
   * Both halves, because there is no useful middle state: a relay is asked to
   * forget the event, and the gateway to forget the name. Keeping the record
   * for a hostname whose TLS handshake has always failed and always will would
   * leave a row in this list forever with nothing to do about it.
   *
   * The gateway going second is deliberate — it is the recoverable half. A
   * deletion request cannot be taken back, so it is the one that has to be
   * worth making on its own.
   */
  const removeStray = async (site: NpanelTakenSite): Promise<void> => {
    if (!user) return;

    setStatus(site.hostname, { kind: 'publishing' });

    const deletion = await user.signer.signEvent({
      kind: 5,
      content: 'Published for a hostname no certificate can cover.',
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', site.event.id],
        ['a', `${site.event.kind}:${user.pubkey}:${eventIdentifier(site.event)}`],
        ['k', String(site.event.kind)],
      ],
    });

    await publishToRelays(nostr, deletion, provider.relayUrls);
    await removeClaim(site.hostname);
    setStatus(site.hostname, { kind: 'deleted', note: 'Retracted, and taken off the gateway.' });
  };

  /** Run `action` over `rows`, one at a time, recording failures per row. */
  const runEach = async <T,>(
    rows: T[],
    key: (row: T) => string,
    action: (row: T) => Promise<void>,
  ): Promise<void> => {
    for (const row of rows) {
      if (settled(key(row))) continue;

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

  /**
   * One row's action, on its own.
   *
   * Still holds the whole dialog while it runs. A signer answers one request at
   * a time whatever the UI allows, and two buttons that look live but queue
   * behind each other read as a hang.
   */
  const runRow = async (hostname: string, action: () => Promise<void>): Promise<void> => {
    setRunning('row');

    try {
      await action();
      // Deliberately not refetched here. Somebody clearing out twenty sites
      // clicks twenty times, and re-reading the list after each one would cost
      // a signature and a relay round trip to learn what the row already says.
      // The list is caught up when the dialog closes.
      setDirty(true);
    } catch (err) {
      setStatus(hostname, { kind: 'failed', error: err instanceof Error ? err.message : 'Failed' });
    }

    setRunning(null);
  };

  const migrateAll = async () => {
    setRunning('migrate');
    // One at a time: a remote signer answers one request at a time anyway, and
    // a failure halfway through should leave a list somebody can read rather
    // than a hundred simultaneous errors.
    await runEach(actionable, (claim) => claim.hostname, migrate);
    setRunning(null);
    setDirty(true);
    // Whatever succeeded is no longer waiting, and whatever failed still is.
    queryClient.invalidateQueries({ queryKey: ['npanel-claims'] });
  };

  const fixTitles = async () => {
    setRunning('titles');
    await runEach(retitlable, (site) => site.hostname, retitle);
    setRunning(null);
    setDirty(true);
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
      case 'deleting':
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Deleting…
          </span>
        );
      case 'deleted':
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="h-3 w-3 shrink-0" />
            {status.note ?? `Deleted from ${provider.domain}.`}
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

  /** Names still worth running the bulk button over. */
  const remaining = actionable.filter((claim) => !settled(claim.hostname)).length;

  /**
   * Where this sitting has got to, said once.
   *
   * Deleting is reported alongside taking names back rather than folded into
   * it, because they are opposite decisions and somebody who has just made
   * thirty of them should be able to see that they did.
   */
  const summary = (() => {
    const parts: string[] = [];
    if (done) parts.push(`${done} done`);
    if (deleted) parts.push(`${deleted} deleted`);
    if (failed) parts.push(`${failed} failed`);

    if (failed) return `${parts.join(', ')} — try the failed ones again.`;
    if (parts.length) {
      return `${parts.join(', ')}. A republished site takes the gateway about a minute to pick up.`;
    }
    return `${remaining} to migrate.`;
  })();

  /**
   * Close, and let the lists catch up.
   *
   * Marked stale rather than refetched: the query is disabled while the dialog
   * is shut, so nothing is asked until somebody opens it again — and asking
   * costs a signature, which on a remote signer costs a round trip.
   */
  const close = () => {
    if (dirty) {
      queryClient.invalidateQueries({ queryKey: ['npanel-claims'] });
      queryClient.invalidateQueries({ queryKey: ['npanel-claim-count'] });
    }
    onOpenChange(false);
  };

  /**
   * What can be done about one name, minus whatever does not apply to it.
   *
   * Every row gets its own controls rather than only the bulk button, because
   * the list is not a queue of decisions already made. Somebody with forty
   * names on file wants three of them back and the rest gone, and until now the
   * only thing the dialog would do was hand them all forty.
   */
  const renderActions = (
    hostname: string,
    options: {
      /** Where the site can be looked at, when anywhere can show it. */
      preview?: string;
      /** The one thing this row's section does to a name that is staying. */
      act?: { label: string; icon: LucideIcon; run: () => Promise<void> };
      /** Present when the name can be given up. `published` decides what the confirmation promises. */
      deletable?: { published: boolean };
    },
  ) => {
    const gone = settled(hostname);
    const ActionIcon = options.act?.icon;

    return (
      <div className="shrink-0 flex items-center gap-1">
        {options.preview && (
          <Button size="sm" variant="ghost" className="h-8 px-2 text-muted-foreground" asChild>
            <a href={options.preview} target="_blank" rel="noreferrer">
              <Eye className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Show</span>
            </a>
          </Button>
        )}

        {options.act && ActionIcon && !gone && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2"
            disabled={busy}
            onClick={() => runRow(hostname, options.act!.run)}
          >
            <ActionIcon className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">{options.act.label}</span>
          </Button>
        )}

        {options.deletable && !gone && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-muted-foreground hover:text-destructive"
            disabled={busy}
            aria-label={`Delete ${hostname}`}
            onClick={() => setConfirming({ hostname, published: options.deletable!.published })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={busy ? undefined : (next) => (next ? onOpenChange(true) : close())}>
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
                    <div key={claim.hostname} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{claim.hostname}</div>
                        <div className="truncate">{renderStatus(claim.hostname, describeStep(claim))}</div>
                      </div>
                      {renderActions(claim.hostname, {
                        preview: sitePreviewUrl(claim.address, claim.hostname, provider.domain),
                        // The word the button uses is the work it does. A name
                        // whose site is already on this key publishes nothing.
                        act: {
                          label: claim.step.kind === 'republish' ? 'Publish' : 'Claim',
                          icon: Rocket,
                          run: () => migrate(claim),
                        },
                        // A `claim` step, either reason, means a copy of the site
                        // is already published under this key and survives the
                        // name going away. A `republish` step means it is not.
                        deletable: { published: claim.step.kind === 'claim' },
                      })}
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
                    <div key={site.hostname} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{site.hostname}</div>
                        <div className="truncate">
                          {renderStatus(
                            site.hostname,
                            site.suggestedTitle ? `Will be titled "${site.suggestedTitle}".` : 'The title will be removed.',
                          )}
                        </div>
                      </div>
                      {renderActions(site.hostname, {
                        preview: sitePreviewUrl(
                          `${site.event.kind}:${site.event.pubkey}:${eventIdentifier(site.event)}`,
                          site.hostname,
                          provider.domain,
                        ),
                        act: { label: 'Retitle', icon: Tag, run: () => retitle(site) },
                        deletable: { published: true },
                      })}
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
                    <div key={site.hostname} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-mono text-sm truncate">{site.hostname}</div>
                        <div className="truncate">
                          {renderStatus(
                            site.hostname,
                            `No certificate covers a name this deep under ${provider.domain}.`,
                          )}
                        </div>
                      </div>
                      {/*
                        One button, not two. What is wrong with these is that
                        they exist at all, so there is no version of retracting
                        the manifest that leaves the gateway's record worth
                        keeping — the name has never loaded for anyone and never
                        will. The hostname is unservable, so the preview can only
                        come from the address.
                      */}
                      {renderActions(site.hostname, {
                        preview: nsitePreviewUrl(
                          `${site.event.kind}:${site.event.pubkey}:${eventIdentifier(site.event)}`,
                        ),
                        act: { label: 'Retract', icon: Trash2, run: () => removeStray(site) },
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {blocked.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Needs a decision</h4>
                <p className="text-xs text-muted-foreground">
                  Nothing here can be taken back safely without you choosing something first. Deleting
                  is a decision too, and for most of these it is the right one.
                </p>
                <div className="rounded-md border border-dashed divide-y">
                  {blocked.map((claim) => (
                    <div key={claim.hostname} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-mono text-sm truncate">{claim.hostname}</div>
                        <div className="truncate">{renderStatus(claim.hostname, describeStep(claim))}</div>
                      </div>
                      {renderActions(claim.hostname, {
                        preview: sitePreviewUrl(claim.address, claim.hostname, provider.domain),
                        deletable: { published: claim.mine },
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 gap-2 sm:justify-between items-center">
            <span className="text-xs text-muted-foreground">{summary}</span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => close()} disabled={busy}>
                Close
              </Button>
              <Button onClick={migrateAll} disabled={busy || remaining === 0}>
                {running === 'migrate' ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Migrating…
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4 mr-2" />
                    {failed > 0 ? 'Retry' : `Migrate all (${remaining})`}
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirming !== null} onOpenChange={(next) => !next && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirming?.hostname}?</AlertDialogTitle>
            <AlertDialogDescription>
              {provider.name} stops serving this name and stops holding it for you, and it goes back
              to being anybody's to take. This cannot be undone.{' '}
              {confirming?.published
                ? 'The site itself stays published under your key, and can still be reached by its address.'
                : 'The archived copy stays on Nostr under the key that published it — this only ends the gateway serving it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const hostname = confirming?.hostname;
                setConfirming(null);
                if (hostname) void runRow(hostname, () => removeClaim(hostname));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
