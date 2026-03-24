import { useState, useEffect, useRef } from 'react';
import { nip19 } from 'nostr-tools';
import { AlertCircle, Globe, Tag } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { projectNameToDTag, isValidDTag, pubkeyToBase36 } from '@/lib/utils/nsite';

interface NsiteDeployFormProps {
  gateway: string;
  /** Human-readable project name — used to derive the default dTag and title */
  projectName: string;
  /** Hex pubkey of the logged-in user — used for URL preview */
  userPubkey?: string;
  /** Persisted values from a previous deployment */
  savedSiteTitle?: string;
  savedSiteDescription?: string;
  savedDTag?: string;
  savedSiteType?: 'named' | 'root';
  /** Present only when the project was previously deployed with a dedicated keypair (v1) */
  savedNsec?: string;
  onSiteTitleChange: (title: string) => void;
  onSiteDescriptionChange: (description: string) => void;
  onDTagChange: (dTag: string) => void;
  onSiteTypeChange: (type: 'named' | 'root') => void;
}

export function NsiteDeployForm({
  gateway,
  projectName,
  userPubkey,
  savedSiteTitle,
  savedSiteDescription,
  savedDTag,
  savedSiteType,
  savedNsec,
  onSiteTitleChange,
  onSiteDescriptionChange,
  onDTagChange,
  onSiteTypeChange,
}: NsiteDeployFormProps) {
  const [siteType, setSiteType] = useState<'named' | 'root'>(savedSiteType ?? 'named');
  const [dTag, setDTag] = useState(savedDTag ?? '');
  const [siteTitle, setSiteTitle] = useState(
    savedSiteTitle ?? (savedSiteType === 'root' ? '' : projectName),
  );
  const [siteDescription, setSiteDescription] = useState(savedSiteDescription ?? '');
  const [previewUrl, setPreviewUrl] = useState('');

  // On mount: sync all saved values to parent; derive dTag and title defaults when absent.
  // The component is keyed by selectedProviderId in DeploySteps, so this effect always
  // runs with fresh props — no initialized guard needed.
  useEffect(() => {
    if (savedSiteType) onSiteTypeChange(savedSiteType);
    if (savedSiteDescription) onSiteDescriptionChange(savedSiteDescription);

    // Title: use saved value, else default to projectName for named sites only
    const initialTitle = savedSiteTitle ?? (siteType === 'named' ? projectName : '');
    if (initialTitle !== siteTitle) setSiteTitle(initialTitle);
    onSiteTitleChange(initialTitle);

    // dTag: use saved value, else derive from project name
    if (savedDTag) {
      onDTagChange(savedDTag);
    } else {
      projectNameToDTag(projectName).then(derived => {
        setDTag(derived);
        onDTagChange(derived);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the user switches site type, update the title default only if
  // the current title still matches the previous type's auto-fill value.
  const prevSiteTypeRef = useRef(siteType);
  useEffect(() => {
    const prev = prevSiteTypeRef.current;
    prevSiteTypeRef.current = siteType;
    if (prev === siteType) return;

    if (siteType === 'named' && siteTitle === '') {
      // Switching to named with a blank title → fill with project name
      setSiteTitle(projectName);
      onSiteTitleChange(projectName);
    } else if (siteType === 'root' && siteTitle === projectName) {
      // Switching to root and title is still the auto-filled project name → clear it
      setSiteTitle('');
      onSiteTitleChange('');
    }
  }, [siteType, siteTitle, projectName, onSiteTitleChange]);

  // Recompute preview URL whenever relevant state changes
  useEffect(() => {
    if (!userPubkey) {
      setPreviewUrl('');
      return;
    }
    if (siteType === 'root') {
      const npub = nip19.npubEncode(userPubkey);
      setPreviewUrl(`https://${npub}.${gateway}`);
    } else if (dTag && isValidDTag(dTag)) {
      const base36 = pubkeyToBase36(userPubkey);
      setPreviewUrl(`https://${base36}${dTag}.${gateway}`);
    } else {
      setPreviewUrl('');
    }
  }, [userPubkey, siteType, dTag, gateway]);

  const handleSiteTypeChange = (value: 'named' | 'root') => {
    setSiteType(value);
    onSiteTypeChange(value);
  };

  const handleDTagChange = (value: string) => {
    // Allow lowercase alphanumeric and hyphens; strip everything else.
    // Leading/trailing hyphens and consecutive hyphens are caught by isValidDTag
    // and shown as a validation error rather than silently removed while typing.
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setDTag(clean);
    onDTagChange(clean);
  };

  const handleSiteTitleChange = (value: string) => {
    setSiteTitle(value);
    onSiteTitleChange(value);
  };

  const handleSiteDescriptionChange = (value: string) => {
    setSiteDescription(value);
    onSiteDescriptionChange(value);
  };

  const dTagInvalid = siteType === 'named' && dTag.length > 0 && !isValidDTag(dTag);

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
                A site with a custom identifier. You can have many named sites.
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

      {/* Named site identifier */}
      {siteType === 'named' && (
        <div className="space-y-2">
          <Label htmlFor="nsite-dtag">Site Identifier</Label>
          <Input
            id="nsite-dtag"
            value={dTag}
            onChange={(e) => handleDTagChange(e.target.value)}
            placeholder="myblog"
            maxLength={13}
            className={dTagInvalid ? 'border-destructive' : ''}
          />
          {dTagInvalid ? (
            <p className="text-xs text-destructive">
              Must be 1–13 lowercase letters, digits, or hyphens. Cannot start or end with a hyphen.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, and hyphens, max 13 characters.
            </p>
          )}
        </div>
      )}

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

      {/* Live URL preview */}
      {previewUrl && (
        <div className="space-y-1">
          <Label>Site URL</Label>
          <p className="text-sm font-mono bg-muted p-2 rounded-md break-all">
            {previewUrl}
          </p>
        </div>
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
