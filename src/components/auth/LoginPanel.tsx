import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ExternalLink, Loader2, Upload } from 'lucide-react';
import {
  generateNostrConnectParams,
  generateNostrConnectURI,
  type NostrConnectParams,
} from '@nostrify/react/login';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useAppContext } from '@/hooks/useAppContext';

interface LoginPanelProps {
  /** Called after a successful login (nostrconnect QR, nsec, bunker URI, or key file). */
  onLoggedIn: () => void;
}

const NSEC_REGEX = /^nsec1[a-zA-Z0-9]{58}$/;

type InputKind = 'nsec' | 'bunker' | 'unknown';

const detectInputKind = (value: string): InputKind => {
  const trimmed = value.trim();
  if (NSEC_REGEX.test(trimmed)) return 'nsec';
  if (trimmed.startsWith('bunker://')) return 'bunker';
  return 'unknown';
};

// UA-based mobile check. Distinct from the viewport-based `useIsMobile` —
// here we care whether the platform can deep-link into a signer app, not
// whether the window is narrow.
const isMobileDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

/**
 * Unified login panel for all string-based methods:
 * - `nostrconnect://` flow gated behind a button. Desktop reveals a QR code;
 *   mobile redirects to a signer-app deep-link.
 * - A single paste input that accepts either an `nsec1…` secret key OR a
 *   `bunker://` URI — the type is detected from the string on submit.
 * - File upload for plain-text nsec / bunker URI files.
 *
 * The nostrconnect session is only opened when the user clicks the button
 * (so the dialog doesn't open a relay subscription for users who just want
 * to paste a key). Panel unmount aborts any in-flight listener.
 */
export const LoginPanel: React.FC<LoginPanelProps> = ({ onLoggedIn }) => {
  const login = useLoginActions();
  const { config } = useAppContext();

  // Session is gated: stays idle until the user clicks the remote-signer
  // button. Bumping `sessionToken` while started restarts the session
  // (used by "Try again").
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionToken, setSessionToken] = useState(0);
  const [nostrConnectUri, setNostrConnectUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [hasOpenedSigner, setHasOpenedSigner] = useState(false);
  // Mobile-only: tracks "user pressed Open signer app but the URI isn't
  // generated yet — navigate as soon as it is."
  const [pendingNavigate, setPendingNavigate] = useState(false);

  // Unified text input — accepts nsec or bunker URI, type detected on submit.
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [isInputLoggingIn, setIsInputLoggingIn] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  // Refs so the listener effect can read the latest values without
  // re-running on every parent re-render. `config` is rebuilt every render
  // by AppProvider, so we must NOT depend on it in the effect's dep array —
  // otherwise the in-flight subscription is torn down on each parent render.
  const loginRef = useRef(login);
  const onLoggedInRef = useRef(onLoggedIn);
  const configRef = useRef(config);

  useEffect(() => {
    loginRef.current = login;
    onLoggedInRef.current = onLoggedIn;
    configRef.current = config;
  });

  const isMobile = isMobileDevice();

  // Open a nostrconnect session and start listening for the signer. Runs
  // only after the user clicks the start button (`sessionStarted=true`),
  // and re-runs when `sessionToken` is bumped by "Try again".
  useEffect(() => {
    if (!sessionStarted) return;

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

      // Publish the URI ASAP so a pending mobile navigate can fire while
      // the QR renders in the background.
      if (cancelled) return;
      setNostrConnectUri(uri);
      setConnectError(null);

      // Desktop renders a QR; mobile redirects, so skip the work there.
      if (!isMobileDevice()) {
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
      }

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
    // Intentional: deps limited to `sessionStarted` + `sessionToken` so
    // parent re-renders don't tear down the in-flight subscription. Config
    // + login are read via refs that are updated each render.
  }, [sessionStarted, sessionToken]);

  // Mobile: once the URI is ready and the user already tapped "Open signer
  // app", navigate to the deep-link. Runs once per click; the flag is
  // consumed here.
  useEffect(() => {
    if (!pendingNavigate || !nostrConnectUri || connectError) return;
    setPendingNavigate(false);
    setHasOpenedSigner(true);
    window.location.href = nostrConnectUri;
  }, [pendingNavigate, nostrConnectUri, connectError]);

  const handleStartDesktopSession = () => {
    setSessionStarted(true);
  };

  const handleOpenSignerApp = () => {
    // Mobile: arm the navigate-when-ready effect and start the session.
    // If the session is already running (e.g. retry after error), this
    // just navigates with the existing URI.
    setPendingNavigate(true);
    setSessionStarted(true);
  };

  const handleConnectRetry = useCallback(() => {
    setNostrConnectUri('');
    setQrDataUrl('');
    setConnectError(null);
    setHasOpenedSigner(false);
    setPendingNavigate(false);
    setSessionToken((t) => t + 1);
  }, []);

  const submitInput = async (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setInputError('Enter a secret key or bunker URI');
      return;
    }

    const kind = detectInputKind(trimmed);
    if (kind === 'unknown') {
      setInputError('Unrecognized format. Expected nsec1… or bunker://…');
      return;
    }

    setIsInputLoggingIn(true);
    setInputError(null);

    try {
      if (kind === 'nsec') {
        // login.nsec is synchronous but throws on bad keys.
        login.nsec(trimmed);
      } else {
        await login.bunker(trimmed);
      }
      onLoggedIn();
    } catch {
      setInputError(
        kind === 'nsec'
          ? "Failed to log in with this key. Please check that it's correct."
          : 'Failed to connect to bunker. Please check the URI.',
      );
    } finally {
      setIsInputLoggingIn(false);
    }
  };

  const handleSubmit = () => {
    void submitInput(input);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setInputError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      setIsFileLoading(false);
      const content = event.target?.result as string;
      if (!content) {
        setInputError('Could not read file content.');
        return;
      }
      const trimmed = content.trim();
      if (detectInputKind(trimmed) === 'unknown') {
        setInputError('File does not contain a valid nsec or bunker URI.');
        return;
      }
      setInput(trimmed);
      void submitInput(trimmed);
    };
    reader.onerror = () => {
      setIsFileLoading(false);
      setInputError('Failed to read file.');
    };
    reader.readAsText(file);
    // Reset so the same file can be selected again after a failure.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const renderRemoteSignerSection = () => {
    // Idle: just a button. Clicking it generates the session and either
    // reveals the QR (desktop) or deep-links to a signer app (mobile).
    if (!sessionStarted) {
      return (
        <Button
          variant="outline"
          onClick={isMobile ? handleOpenSignerApp : handleStartDesktopSession}
          className="w-full h-12"
        >
          <ExternalLink className="w-5 h-5 mr-2" />
          {isMobile ? 'Open signer app' : 'Login with remote signer'}
        </Button>
      );
    }

    if (connectError) {
      return (
        <div className="flex flex-col items-center space-y-3 py-4 w-full">
          <Alert variant="destructive">
            <AlertDescription>{connectError}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={handleConnectRetry}>
            Try again
          </Button>
        </div>
      );
    }

    if (isMobile && hasOpenedSigner) {
      return (
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
      );
    }

    if (!isMobile && qrDataUrl) {
      return (
        <div className="flex flex-col items-center space-y-4 w-full">
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
          <button
            type="button"
            onClick={handleConnectRetry}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
          >
            Generate a new code
          </button>
        </div>
      );
    }

    // Mobile pre-navigate or desktop pre-QR — short transient state.
    return (
      <div className="flex items-center justify-center h-[120px]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {renderRemoteSignerSection()}

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t"></div>
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">
            or paste a key or URI
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <Input
          type="password"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (inputError) setInputError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim() && !isInputLoggingIn) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="nsec1… or bunker://…"
          className={inputError ? 'border-red-500' : ''}
          autoComplete="off"
        />
        {inputError && (
          <p className="text-sm text-red-500">{inputError}</p>
        )}
      </div>

      <div className="flex space-x-2">
        <Button
          onClick={handleSubmit}
          disabled={isInputLoggingIn || isFileLoading || !input.trim()}
          className="flex-1"
        >
          {isInputLoggingIn ? 'Adding…' : 'Add account'}
        </Button>

        <input
          type="file"
          accept=".txt"
          className="hidden"
          ref={fileInputRef}
          onChange={handleFileUpload}
        />
        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={isInputLoggingIn || isFileLoading}
          className="px-3"
          title="Upload a file containing an nsec or bunker URI"
        >
          {isFileLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
        </Button>
      </div>
    </div>
  );
};

export default LoginPanel;
