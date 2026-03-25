import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertCircle, Globe, Tag } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

interface NsiteDeployFormProps {
  /** Human-readable project name — used to default the title for named sites */
  projectName: string;
  /** Persisted values from a previous deployment */
  savedSiteTitle?: string;
  savedSiteDescription?: string;
  savedSiteType?: 'named' | 'root';
  /** Present only when the project was previously deployed with a dedicated keypair (v1) */
  savedNsec?: string;
  onSiteTitleChange: (title: string) => void;
  onSiteDescriptionChange: (description: string) => void;
  onSiteTypeChange: (type: 'named' | 'root') => void;
}

export function NsiteDeployForm({
  projectName,
  savedSiteTitle,
  savedSiteDescription,
  savedSiteType,
  savedNsec,
  onSiteTitleChange,
  onSiteDescriptionChange,
  onSiteTypeChange,
}: NsiteDeployFormProps) {
  const [siteType, setSiteType] = useState<'named' | 'root'>(savedSiteType ?? 'named');
  const [siteTitle, setSiteTitle] = useState(
    savedSiteTitle ?? (savedSiteType === 'root' ? '' : projectName),
  );
  const [siteDescription, setSiteDescription] = useState(savedSiteDescription ?? '');

  // On mount: sync all saved values to parent and set defaults.
  // The component is keyed by selectedProviderId in DeploySteps, so this always
  // runs with fresh props — no initialized guard needed.
  const initializedRef = useRef(false);
  const stableSyncToParent = useCallback(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (savedSiteType) onSiteTypeChange(savedSiteType);
    if (savedSiteDescription) onSiteDescriptionChange(savedSiteDescription);

    const initialTitle = savedSiteTitle ?? (siteType === 'named' ? projectName : '');
    if (initialTitle !== siteTitle) setSiteTitle(initialTitle);
    onSiteTitleChange(initialTitle);
  }, [savedSiteType, savedSiteDescription, savedSiteTitle, siteType, siteTitle, projectName, onSiteTypeChange, onSiteDescriptionChange, onSiteTitleChange]);

  useEffect(() => {
    stableSyncToParent();
  }, [stableSyncToParent]);

  // When the user switches site type, update the title default only if
  // the current title still matches the previous type's auto-fill value.
  const prevSiteTypeRef = useRef(siteType);
  useEffect(() => {
    const prev = prevSiteTypeRef.current;
    prevSiteTypeRef.current = siteType;
    if (prev === siteType) return;

    if (siteType === 'named' && siteTitle === '') {
      setSiteTitle(projectName);
      onSiteTitleChange(projectName);
    } else if (siteType === 'root' && siteTitle === projectName) {
      setSiteTitle('');
      onSiteTitleChange('');
    }
  }, [siteType, siteTitle, projectName, onSiteTitleChange]);

  const handleSiteTypeChange = (value: 'named' | 'root') => {
    setSiteType(value);
    onSiteTypeChange(value);
  };

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

      {/* Site type */}
      <div className="space-y-2">
        <Label>Site Type</Label>
        <RadioGroup
          value={siteType}
          onValueChange={handleSiteTypeChange}
          className="space-y-2"
        >
          <div className="flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors">
            <RadioGroupItem value="named" id="nsite-type-named" className="mt-0.5" />
            <label htmlFor="nsite-type-named" className="flex-1 cursor-pointer">
              <div className="flex items-center gap-2 font-medium text-sm">
                <Tag className="h-3.5 w-3.5" />
                Named site
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                A site with a unique identifier. You can have many named sites.
              </p>
            </label>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors">
            <RadioGroupItem value="root" id="nsite-type-root" className="mt-0.5" />
            <label htmlFor="nsite-type-root" className="flex-1 cursor-pointer">
              <div className="flex items-center gap-2 font-medium text-sm">
                <Globe className="h-3.5 w-3.5" />
                Root site
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your personal site at your npub address. You can only have one.
              </p>
            </label>
          </div>
        </RadioGroup>
      </div>

      {/* Root site warning */}
      {siteType === 'root' && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            You only have one root site per Nostr identity. Deploying here will replace any
            existing root site published under your key.
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
