import React, { useState, useEffect, useRef } from 'react';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
// Alert components removed as they're not used in the simplified design
import { useLoginActions } from '@/hooks/useLoginActions';
import { cn } from '@/lib/utils';
import BunkerLoginPanel from '@/components/auth/BunkerLoginPanel';

// Only using key-add step now

interface SimpleLoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  onSignup?: () => void;
}

const validateNsec = (nsec: string) => {
  return /^nsec1[a-zA-Z0-9]{58}$/.test(nsec);
};

const SimpleLoginDialog: React.FC<SimpleLoginDialogProps> = ({
  isOpen,
  onClose,
  onLogin,
  onSignup
}) => {
  // Removed step state - we only have one step now
  const [isLoading, setIsLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [nsec, setNsec] = useState('');
  const [activeTab, setActiveTab] = useState<'nsec' | 'bunker'>('nsec');
  const [errors, setErrors] = useState<{
    nsec?: string;
    extension?: string;
    file?: string;
  }>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const login = useLoginActions();

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setIsLoading(false);
      setIsFileLoading(false);
      setNsec('');
      setActiveTab('nsec');
      setErrors({});
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [isOpen]);

  const handleExtensionLogin = async () => {
    setIsLoading(true);
    setErrors(prev => ({ ...prev, extension: undefined }));

    try {
      if (!('nostr' in window)) {
        throw new Error('Nostr extension not found. Please install a NIP-07 extension.');
      }
      await login.extension();
      onLogin();
      onClose();
    } catch (e: unknown) {
      const error = e as Error;
      setErrors(prev => ({
        ...prev,
        extension: error instanceof Error ? error.message : 'Extension login failed'
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyLogin = () => {
    if (!nsec.trim()) {
      setErrors(prev => ({ ...prev, nsec: 'Please enter your secret key' }));
      return;
    }

    if (!validateNsec(nsec)) {
      setErrors(prev => ({ ...prev, nsec: 'Invalid secret key format. Must be a valid nsec starting with nsec1.' }));
      return;
    }
    executeLogin(nsec);
  };

  const executeLogin = (key: string) => {
    setIsLoading(true);
    setErrors({});

    // Use a timeout to allow the UI to update before the synchronous login call
    setTimeout(() => {
      try {
        login.nsec(key);
        onLogin();
        onClose();
      } catch {
        setErrors({ nsec: "Failed to login with this key. Please check that it's correct." });
        setIsLoading(false);
      }
    }, 50);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setErrors({});

    const reader = new FileReader();
    reader.onload = (event) => {
      setIsFileLoading(false);
      const content = event.target?.result as string;
      if (content) {
        const trimmedContent = content.trim();
        if (validateNsec(trimmedContent)) {
          executeLogin(trimmedContent);
        } else {
          setErrors({ file: 'File does not contain a valid secret key.' });
        }
      } else {
        setErrors({ file: 'Could not read file content.' });
      }
    };
    reader.onerror = () => {
      setIsFileLoading(false);
      setErrors({ file: 'Failed to read file.' });
    };
    reader.readAsText(file);
  };

  const handleSignupClick = () => {
    onClose();
    if (onSignup) {
      onSignup();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-center">Log in</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center space-y-6 py-6">
          <div className="text-center">
            <h3 className="font-semibold mb-2">Welcome back to Shakespeare</h3>
            <p className="text-sm text-muted-foreground">Sign in to your existing account</p>
          </div>

          <div className="w-40 h-40 flex items-center justify-center">
            <div className="w-40 h-40 bg-primary/10 rounded-full flex items-center justify-center">
              <span className="text-8xl">🔑</span>
            </div>
          </div>

          <div className="w-full space-y-4">
            {/* Tab selector */}
            <div className="flex space-x-1 bg-muted rounded-lg p-1">
              <button
                onClick={() => setActiveTab('nsec')}
                className={cn(
                  "flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                  activeTab === 'nsec'
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Secret Key
              </button>
              <button
                onClick={() => setActiveTab('bunker')}
                className={cn(
                  "flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                  activeTab === 'bunker'
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Bunker
              </button>
            </div>

            {activeTab === 'nsec' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Input
                    type="password"
                    value={nsec}
                    onChange={(e) => {
                      setNsec(e.target.value);
                      if (errors.nsec) setErrors(prev => ({ ...prev, nsec: undefined }));
                    }}
                    placeholder="nsec1..."
                    className={errors.nsec ? 'border-red-500' : ''}
                  />
                  {errors.nsec && (
                    <p className="text-sm text-red-500">{errors.nsec}</p>
                  )}
                </div>

                <div className="flex space-x-2">
                  <Button
                    size="lg"
                    onClick={handleKeyLogin}
                    disabled={isLoading || !nsec.trim()}
                    className="flex-1"
                  >
                    {isLoading ? 'Verifying...' : 'Add Key'}
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
                    size="lg"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading || isFileLoading}
                    className="px-3"
                  >
                    <Upload className="w-4 h-4" />
                  </Button>
                </div>

                {errors.file && (
                  <p className="text-sm text-red-500 text-center">{errors.file}</p>
                )}
              </div>
            )}

            {activeTab === 'bunker' && (
              <BunkerLoginPanel
                onLoggedIn={() => {
                  onLogin();
                  onClose();
                }}
              />
            )}

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t"></div>
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or</span>
              </div>
            </div>

            {/* Extension indicator - only show if extension is detected */}
            {window.nostr && (
              <div className="rounded-lg bg-muted p-3">
                <p className="text-xs text-center">
                  <button
                    onClick={handleExtensionLogin}
                    className="text-blue-500 hover:underline"
                    disabled={isLoading}
                  >
                    Sign in with browser extension
                  </button>
                </p>
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
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SimpleLoginDialog;