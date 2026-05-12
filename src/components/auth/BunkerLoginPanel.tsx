import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ChevronDown, ChevronUp, ExternalLink, Loader2 } from 'lucide-react';
import {
  generateNostrConnectParams,
  generateNostrConnectURI,
  type NostrConnectParams,
} from '@nostrify/react/login';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useAppContext } from '@/hooks/useAppContext';

interface BunkerLoginPanelProps {
  /** Called after a successful login (either nostrconnect or pasted bunker URI). */
  onLoggedIn: () => void;
}

const validateBunkerUri = (uri: string) => uri.startsWith('bunker://');

// UA-based mobile check. Distinct from the viewport-based `useIsMobile` —
// here we care whether the platform can deep-link into a signer app, not
// whether the window is narrow.
const isMobileDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

/**
 * Shared NIP-46 login panel: presents a `nostrconnect://` QR code (desktop)
 * or an "Open signer app" deep-link (mobile) as the primary path, with the
 * legacy `bunker://` paste input as a collapsible fallback.
 *
 * Mount/unmount drives the session lifecycle — when the parent's tab is
 * inactive the panel is unmounted, which aborts the listener and clears
 * state. Switching back generates a fresh session.
 */
export const BunkerLoginPanel: React.FC<BunkerLoginPanelProps> = ({ onLoggedIn }) => {
  const login = useLoginActions();
  const { config } = useAppContext();

  const [sessionToken, setSessionToken] = useState(0);
  const [nostrConnectUri, setNostrConnectUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [hasOpenedSigner, setHasOpenedSigner] = useState(false);
  const [showBunkerInput, setShowBunkerInput] = useState(false);
  const [bunkerUri, setBunkerUri] = useState('');
  const [bunkerError, setBunkerError] = useState<string | null>(null);
  const [isBunkerLoggingIn, setIsBunkerLoggingIn] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  // Refs so the listener effect can read the latest values without
  // re-running on every parent re-render. gm-protocol documents the trap:
  // a stale closure mid-handshake silently drops the signer's response.
  // `config` is rebuilt every render by AppProvider, so we must NOT
  // depend on it in the effect's dep array — otherwise the in-flight
  // subscription is torn down on each parent render.
  const loginRef = useRef(login);
  const onLoggedInRef = useRef(onLoggedIn);
  const configRef = useRef(config);

  useEffect(() => {
    loginRef.current = login;
    onLoggedInRef.current = onLoggedIn;
    configRef.current = config;
  });

  const isMobile = isMobileDevice();

  // Generate a session and start listening for the signer. Driven by
  // `sessionToken` so a "Try again" can force a fresh session deterministically.
  // Intentionally has only `sessionToken` in its deps — see comment on the
  // refs above for why.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;

    const run = async () => {
      const relayUrls = (configRef.current.relayMetadata?.relays ?? [])
        .filter((r) => r.write !== false)
        .map((r) => r.url);

      if (relayUrls.length === 0) {
        if (!cancelled) {
          setConnectError(
            'No relays configured. Add a relay in settings to use this login method.',
          );
        }
        return;
      }

      const params: NostrConnectParams = generateNostrConnectParams(relayUrls);
      const uri = generateNostrConnectURI(params, {
        name: 'Shakespeare',
        callback: isMobileDevice()
          ? `${window.location.origin}/remoteloginsuccess`
          : undefined,
      });

      try {
        const dataUrl = await QRCode.toDataURL(uri, {
          width: 400,
          margin: 2,
          color: { dark: '#000000', light: '#FFFFFF' },
        });
        if (cancelled) return;
        setQrDataUrl(dataUrl);
      } catch (e) {
        console.error('Failed to render nostrconnect QR:', e);
      }

      if (cancelled) return;
      setNostrConnectUri(uri);
      setConnectError(null);

      try {
        await loginRef.current.nostrconnect(params, controller.signal);
        if (cancelled || controller.signal.aborted) return;
        onLoggedInRef.current();
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        console.error('nostrconnect failed:', error);
        setConnectError(
          error instanceof Error ? error.message : 'Failed to connect to signer.',
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Intentional: deps limited to `sessionToken` so parent re-renders
    // don't tear down the in-flight subscription. Config + login are read
    // via refs that are updated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  const handleConnectRetry = useCallback(() => {
    setNostrConnectUri('');
    setQrDataUrl('');
    setConnectError(null);
    setHasOpenedSigner(false);
    setSessionToken((t) => t + 1);
  }, []);

  const handleOpenSignerApp = () => {
    if (!nostrConnectUri) return;
    // Flip into the waiting view *before* navigating so the user sees
    // feedback the moment they return from the signer app.
    setHasOpenedSigner(true);
    window.location.href = nostrConnectUri;
  };

  const handleBunkerLogin = async () => {
    if (!bunkerUri.trim()) {
      setBunkerError('Please enter a bunker URI');
      return;
    }
    if (!validateBunkerUri(bunkerUri)) {
      setBunkerError('Invalid bunker URI format. Must start with bunker://');
      return;
    }

    setIsBunkerLoggingIn(true);
    setBunkerError(null);
    try {
      await login.bunker(bunkerUri);
      onLoggedIn();
    } catch {
      setBunkerError('Failed to connect to bunker. Please check the URI.');
    } finally {
      setIsBunkerLoggingIn(false);
    }
  };

  // Mobile: flip to waiting view once the user taps "Open signer app" so
  // the return trip shows progress, not the original button. Desktop:
  // keep the QR scannable (no per-phase progress in @nostrify/react v0.4.1).
  const showWaitingView = isMobile && hasOpenedSigner && !connectError;

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center space-y-4">
        {connectError ? (
          <div className="flex flex-col items-center space-y-3 py-4 w-full">
            <Alert variant="destructive">
              <AlertDescription>{connectError}</AlertDescription>
            </Alert>
            <Button variant="outline" onClick={handleConnectRetry}>
              Try again
            </Button>
          </div>
        ) : showWaitingView ? (
          <div className="flex flex-col items-center space-y-4 py-6 w-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground text-center">
              Waiting for signer&hellip;
            </p>
            <button
              type="button"
              onClick={handleConnectRetry}
              className="text-sm text-primary hover:underline underline-offset-4 font-medium"
            >
              Cancel
            </button>
          </div>
        ) : nostrConnectUri && qrDataUrl ? (
          <>
            {!isMobile && (
              <>
                <div className="p-3 bg-white rounded-xl">
                  <img
                    src={qrDataUrl}
                    alt="nostrconnect QR code"
                    width={200}
                    height={200}
                    className="block"
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center max-w-[260px]">
                  Scan this QR code with your Nostr signer app to log in.
                </p>
              </>
            )}

            {isMobile && (
              <Button onClick={handleOpenSignerApp} className="w-full h-12">
                <ExternalLink className="w-5 h-5 mr-2" />
                Open signer app
              </Button>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-[200px]">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      <Collapsible open={showBunkerInput} onOpenChange={setShowBunkerInput}>
        <CollapsibleTrigger className="w-full flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground py-2">
          <span>Enter bunker URI manually</span>
          {showBunkerInput ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-2">
          <Input
            value={bunkerUri}
            onChange={(e) => {
              setBunkerUri(e.target.value);
              if (bunkerError) setBunkerError(null);
            }}
            placeholder="bunker://"
            className={bunkerError ? 'border-red-500' : ''}
            autoComplete="off"
          />
          {bunkerError && (
            <p className="text-sm text-red-500">{bunkerError}</p>
          )}
          <Button
            variant="outline"
            onClick={handleBunkerLogin}
            disabled={isBunkerLoggingIn || !bunkerUri.trim()}
            className="w-full"
          >
            {isBunkerLoggingIn ? 'Connecting...' : 'Connect with bunker URI'}
          </Button>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export default BunkerLoginPanel;
