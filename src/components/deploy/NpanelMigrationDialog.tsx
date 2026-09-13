import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { AlertCircle, Check, ExternalLink, Loader2, Rocket } from 'lucide-react';
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
import { useNpanelClaims, type NpanelClaimPlan } from '@/hooks/useNpanelClaims';
import type { NpanelProvider } from '@/contexts/DeploySettingsContext';
import { claimNpanelHostname } from '@/lib/deploy/npanelApi';
import { NAMED_SITE_KIND, republishTags } from '@/lib/deploy/npanelMigration';
import { cn } from '@/lib/utils';

/** How long a manifest is given to reach the relays. */
const PUBLISH_TIMEOUT_MS = 10_000;

/** Where a single name has got to. */
type RowStatus =
  | { kind: 'waiting' }
  | { kind: 'publishing' }
  | { kind: 'claiming' }
  | { kind: 'done' }
  | { kind: 'failed'; error: string };

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

export function NpanelMigrationDialog({ open, onOpenChange, provider }: NpanelMigrationDialogProps) {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { data: claims, isLoading, error } = useNpanelClaims(open ? provider : undefined);

  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [running, setRunning] = useState(false);

  const actionable = (claims ?? []).filter((claim) => claim.step.kind !== 'blocked');
  const blocked = (claims ?? []).filter((claim) => claim.step.kind === 'blocked');
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

    if (claim.step.kind === 'republish') {
      setStatus(claim.hostname, { kind: 'publishing' });

      const event = await user.signer.signEvent({
        kind: NAMED_SITE_KIND,
        content: claim.step.manifest.content,
        created_at: Math.floor(Date.now() / 1000),
        tags: republishTags(claim.step.manifest, claim.step.identifier, provider.relayUrls),
      });

      await nostr
        .group(provider.relayUrls)
        .event(event, { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) });

      address = `${NAMED_SITE_KIND}:${user.pubkey}:${claim.step.identifier}`;
    } else {
      address = claim.step.address;
    }

    setStatus(claim.hostname, { kind: 'claiming' });
    await claimNpanelHostname(provider.dashboardHost, user.signer, claim.hostname, address);
    setStatus(claim.hostname, { kind: 'done' });
  };

  const migrateAll = async () => {
    setRunning(true);

    // One at a time: a remote signer answers one request at a time anyway, and
    // a failure halfway through should leave a list somebody can read rather
    // than a hundred simultaneous errors.
    for (const claim of actionable) {
      if (statuses[claim.hostname]?.kind === 'done') continue;

      try {
        await migrate(claim);
      } catch (err) {
        setStatus(claim.hostname, {
          kind: 'failed',
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }

    setRunning(false);
    // Whatever succeeded is no longer waiting, and whatever failed still is.
    queryClient.invalidateQueries({ queryKey: ['npanel-claims'] });
  };

  const renderStatus = (claim: NpanelClaimPlan) => {
    const status = statuses[claim.hostname] ?? { kind: 'waiting' as const };

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
          <a
            href={`https://${claim.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Check className="h-3 w-3" /> Yours <ExternalLink className="h-3 w-3" />
          </a>
        );
      case 'failed':
        return <span className="text-xs text-destructive">{status.error}</span>;
      case 'waiting':
        return <span className="text-xs text-muted-foreground">{describeStep(claim)}</span>;
    }
  };

  return (
    <Dialog open={open} onOpenChange={running ? undefined : onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Take back your sites</DialogTitle>
          <DialogDescription>
            These names on {provider.domain} were yours before this gateway took the domain over.
            They are being served from an archive key until you publish your own copy.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">
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

          {claims && claims.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Nothing is waiting for you here.
            </p>
          )}

          {actionable.length > 0 && (
            <div className="rounded-md border divide-y">
              {actionable.map((claim) => (
                <div key={claim.hostname} className="flex items-center justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <div className="font-mono text-sm truncate">{claim.hostname}</div>
                    <div className="truncate">{renderStatus(claim)}</div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 text-xs rounded-full px-2 py-0.5 border',
                      claim.step.kind === 'republish'
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground border-dashed',
                    )}
                  >
                    {claim.step.kind === 'republish' ? 'republish' : 'claim'}
                  </span>
                </div>
              ))}
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
              ? `${done} of ${actionable.length} done, ${failed} failed — run it again to retry.`
              : done > 0
                ? `${done} of ${actionable.length} done. A republished site takes the gateway about a minute to pick up.`
                : `${actionable.length} to migrate.`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
              Close
            </Button>
            <Button onClick={migrateAll} disabled={running || actionable.length === 0}>
              {running ? (
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
