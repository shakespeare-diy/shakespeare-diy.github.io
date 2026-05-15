// NOTE: This file is stable and usually should not be modified.
// It is important that all functionality in this file is preserved, and should only be modified if explicitly requested.

import React, { useState, useEffect } from 'react';
import { Shield, AlertTriangle, UserPlus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogDescription } from "@/components/ui/dialog";
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLoginActions } from '@/hooks/useLoginActions';
import { cn } from '@/lib/utils';
import LoginPanel from '@/components/auth/LoginPanel';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onSignup?: () => void;
}

const LoginDialog: React.FC<LoginDialogProps> = ({ isOpen, onClose, onLogin, onSignup }) => {
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
      console.error('Extension login failed:', error);
      setExtensionError(
        error instanceof Error ? error.message : 'Extension login failed',
      );
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

  const hasExtension = typeof window !== 'undefined' && 'nostr' in window;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className={cn("max-w-[95vw] sm:max-w-md max-h-[90vh] max-h-[90dvh] p-0 overflow-hidden rounded-2xl overflow-y-scroll")}
      >
        <DialogHeader className={cn('px-6 pt-6 pb-1 relative')}>

          <DialogDescription className="text-center">
              Sign up or log in to continue
          </DialogDescription>
        </DialogHeader>
        <div className='px-6 pt-2 pb-4 space-y-4 overflow-y-auto flex-1'>
          {/* Prominent Sign Up Section */}
          <div className='relative p-4 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-blue-950/50 dark:to-indigo-950/50 border border-blue-200 dark:border-blue-800 overflow-hidden'>
            <div className='relative z-10 text-center space-y-3'>
              <div className='flex justify-center items-center gap-2 mb-2'>
                <Sparkles className='w-5 h-5 text-blue-600' />
                <span className='font-semibold text-blue-800 dark:text-blue-200'>
                  New to Nostr?
                </span>
              </div>
              <p className='text-sm text-blue-700 dark:text-blue-300'>
                Create a new account to get started. It's free and open.
              </p>
              <Button
                onClick={handleSignupClick}
                className='w-full rounded-full py-3 text-base font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 transform transition-all duration-200 hover:scale-105 shadow-lg border-0'
              >
                <UserPlus className='w-4 h-4 mr-2' />
                <span>Sign Up</span>
              </Button>
            </div>
          </div>

          {/* Divider */}
          <div className='relative'>
            <div className='absolute inset-0 flex items-center'>
              <div className='w-full border-t border-gray-300 dark:border-gray-600'></div>
            </div>
            <div className='relative flex justify-center text-sm'>
              <span className='px-3 bg-background text-muted-foreground'>
                <span>Or log in</span>
              </span>
            </div>
          </div>

          {/* Unified login panel — QR + nsec/bunker input + file upload */}
          <LoginPanel onLoggedIn={handleLoggedIn} />

          {/* Extension login (only shown when a NIP-07 extension is present) */}
          {hasExtension && (
            <div className='rounded-lg bg-muted p-3 space-y-2'>
              {extensionError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{extensionError}</AlertDescription>
                </Alert>
              )}
              <Button
                variant='outline'
                className='w-full rounded-full'
                onClick={handleExtensionLogin}
                disabled={isExtensionLoading}
              >
                <Shield className='w-4 h-4 mr-2' />
                {isExtensionLoading ? 'Logging in…' : 'Sign in with browser extension'}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default LoginDialog;
