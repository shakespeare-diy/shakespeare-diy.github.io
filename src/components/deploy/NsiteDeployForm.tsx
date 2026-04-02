import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface NsiteDeployFormProps {
  /** Human-readable project name — used to default the title */
  projectName: string;
  /** Persisted values from a previous deployment */
  savedSiteTitle?: string;
  savedSiteDescription?: string;
  /** Present only when the project was previously deployed with a dedicated keypair (v1) */
  savedNsec?: string;
  onSiteTitleChange: (title: string) => void;
  onSiteDescriptionChange: (description: string) => void;
}

export function NsiteDeployForm({
  projectName,
  savedSiteTitle,
  savedSiteDescription,
  savedNsec,
  onSiteTitleChange,
  onSiteDescriptionChange,
}: NsiteDeployFormProps) {
  const [siteTitle, setSiteTitle] = useState(savedSiteTitle ?? projectName);
  const [siteDescription, setSiteDescription] = useState(savedSiteDescription ?? '');

  // On mount: sync all saved values to parent and set defaults.
  // The component is keyed by selectedProviderId in DeploySteps, so this always
  // runs with fresh props — no initialized guard needed.
  const initializedRef = useRef(false);
  const stableSyncToParent = useCallback(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (savedSiteDescription) onSiteDescriptionChange(savedSiteDescription);

    const initialTitle = savedSiteTitle ?? projectName;
    if (initialTitle !== siteTitle) setSiteTitle(initialTitle);
    onSiteTitleChange(initialTitle);
  }, [savedSiteDescription, savedSiteTitle, siteTitle, projectName, onSiteDescriptionChange, onSiteTitleChange]);

  useEffect(() => {
    stableSyncToParent();
  }, [stableSyncToParent]);

  const handleSiteTitleChange = (value: string) => {
    setSiteTitle(value);
    onSiteTitleChange(value);
  };

  const handleSiteDescriptionChange = (value: string) => {
    setSiteDescription(value);
    onSiteDescriptionChange(value);
  };

  return (
    <div className="space-y-4">

      {/* Migration notice */}
      {savedNsec && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <strong>Site identity is changing.</strong> This project was previously deployed with a
            dedicated private key. Going forward, it will deploy under your Nostr identity. The old
            site will remain at its original address until overwritten.
          </AlertDescription>
        </Alert>
      )}

      {/* Site title */}
      <div className="space-y-2">
        <Label htmlFor="nsite-title">Site Title</Label>
        <Input
          id="nsite-title"
          value={siteTitle}
          onChange={(e) => handleSiteTitleChange(e.target.value)}
          placeholder="My Nostr Site"
        />
        <p className="text-xs text-muted-foreground">
          Shown by nsite gateways and directories. Included as a title tag in the manifest.
        </p>
      </div>

      {/* Site description */}
      <div className="space-y-2">
        <Label htmlFor="nsite-description">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Textarea
          id="nsite-description"
          value={siteDescription}
          onChange={(e) => handleSiteDescriptionChange(e.target.value)}
          placeholder="A short description of this site…"
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Included as a description tag in the manifest.
        </p>
      </div>
    </div>
  );
}
