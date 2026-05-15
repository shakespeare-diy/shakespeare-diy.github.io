import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLoginActions } from '@/hooks/useLoginActions';
import LoginPanel from '@/components/auth/LoginPanel';

interface SimpleLoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onSignup?: () => void;
}

const SimpleLoginDialog: React.FC<SimpleLoginDialogProps> = ({
  isOpen,
  onClose,
  onLogin,
  onSignup
}) => {
  const [isExtensionLoading, setIsExtensionLoading] = useState(false);
  const [extensionError, setExtensionError] = useState<string | null>(null);

  const login = useLoginActions();

  useEffect(() => {
    if (isOpen) {
      setIsExtensionLoading(false);
      setExtensionError(null);
    }
  }, [isOpen]);

  const handleExtensionLogin = async () => {
    setIsExtensionLoading(true);
    setExtensionError(null);

    try {
      if (!('nostr' in window)) {
        throw new Error('Nostr extension not found. Please install a NIP-07 extension.');
      }
      await login.extension();
      onLogin();
      onClose();
    } catch (e: unknown) {
      const error = e as Error;
      setExtensionError(error instanceof Error ? error.message : 'Extension login failed');
    } finally {
      setIsExtensionLoading(false);
    }
  };

  const handleSignupClick = () => {
    onClose();
    if (onSignup) {
      onSignup();
    }
  };

  const handleLoggedIn = () => {
    onLogin();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-center">Log in</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center space-y-6 py-4">
          <div className="text-center">
            <h3 className="font-semibold mb-2">Welcome back to Shakespeare</h3>
            <p className="text-sm text-muted-foreground">Sign in to your existing account</p>
          </div>

          <div className="w-full">
            <LoginPanel onLoggedIn={handleLoggedIn} />
          </div>

          {window.nostr && (
            <div className="w-full rounded-lg bg-muted p-3">
              <p className="text-xs text-center">
                <button
                  onClick={handleExtensionLogin}
                  className="text-blue-500 hover:underline disabled:opacity-50"
                  disabled={isExtensionLoading}
                >
                  {isExtensionLoading ? 'Connecting…' : 'Sign in with browser extension'}
                </button>
              </p>
              {extensionError && (
                <p className="text-xs text-red-500 text-center mt-2">{extensionError}</p>
              )}
            </div>
          )}

          <div className="flex justify-center space-x-2 text-xs">
            <span className="text-muted-foreground">New to Shakespeare?</span>
            <button
              onClick={handleSignupClick}
              className="text-blue-500 hover:underline"
            >
              Create Account
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SimpleLoginDialog;
