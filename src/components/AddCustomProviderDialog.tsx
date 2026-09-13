import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { UrlListEditor } from '@/components/UrlListEditor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  NpanelProvider,
  NetlifyProvider,
  VercelProvider,
  NsiteProvider,
  CloudflareProvider,
  DenoDeployProvider,
  RailwayProvider,
} from '@/contexts/DeploySettingsContext';

// Type for provider without the 'id' field (will be generated)
type DeployProviderInput =
  | Omit<NpanelProvider, 'id'>
  | Omit<NetlifyProvider, 'id'>
  | Omit<VercelProvider, 'id'>
  | Omit<NsiteProvider, 'id'>
  | Omit<CloudflareProvider, 'id'>
  | Omit<DenoDeployProvider, 'id'>
  | Omit<RailwayProvider, 'id'>;

interface AddCustomProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: DeployProviderInput) => void;
}

export function AddCustomProviderDialog({
  open,
  onOpenChange,
  onAdd,
}: AddCustomProviderDialogProps) {
  const { t } = useTranslation();
  const [customProviderType, setCustomProviderType] = useState<'npanel' | 'netlify' | 'vercel' | 'nsite' | 'cloudflare' | 'deno' | 'railway' | ''>('');
  const [customName, setCustomName] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customAccountId, setCustomAccountId] = useState('');
  const [customOrganizationId, setCustomOrganizationId] = useState('');
  const [customBaseURL, setCustomBaseURL] = useState('');
  const [customBaseDomain, setCustomBaseDomain] = useState('');
  const [customDashboardHost, setCustomDashboardHost] = useState('');
  const [customProxy, setCustomProxy] = useState(false);
  const [customGateway, setCustomGateway] = useState('');
  const [customRelayUrls, setCustomRelayUrls] = useState<string[]>([]);
  const [customBlossomServers, setCustomBlossomServers] = useState<string[]>([]);

  const handleAdd = () => {
    if (!customProviderType || !customName.trim()) return;

    // Build provider object based on type
    let provider: DeployProviderInput;

    if (customProviderType === 'npanel') {
      if (!customDashboardHost.trim() || !customGateway.trim()) return;
      provider = {
        type: 'npanel',
        name: customName.trim(),
        dashboardHost: customDashboardHost.trim(),
        domain: customGateway.trim(),
        relayUrls: customRelayUrls.length > 0 ? customRelayUrls : ['wss://relay.ditto.pub'],
        blossomServers: customBlossomServers.length > 0 ? customBlossomServers : ['https://blossom.ditto.pub/', 'https://blossom.dreamith.to/'],
      };
    } else if (customProviderType === 'nsite') {
      provider = {
        type: 'nsite',
        name: customName.trim(),
        gateway: customGateway.trim() || 'shakespeare.to',
        relayUrls: customRelayUrls.length > 0 ? customRelayUrls : ['wss://relay.ditto.pub'],
        blossomServers: customBlossomServers.length > 0 ? customBlossomServers : ['https://blossom.ditto.pub/', 'https://blossom.dreamith.to/'],
      };
    } else if (customProviderType === 'netlify') {
      if (!customApiKey.trim()) return;
      provider = {
        type: 'netlify',
        name: customName.trim(),
        apiKey: customApiKey.trim(),
        ...(customBaseURL?.trim() && { baseURL: customBaseURL.trim() }),
        ...(customProxy && { proxy: true }),
      };
    } else if (customProviderType === 'vercel') {
      if (!customApiKey.trim()) return;
      provider = {
        type: 'vercel',
        name: customName.trim(),
        apiKey: customApiKey.trim(),
        ...(customBaseURL?.trim() && { baseURL: customBaseURL.trim() }),
        ...(customProxy && { proxy: true }),
      };
    } else if (customProviderType === 'cloudflare') {
      if (!customApiKey.trim() || !customAccountId.trim()) return;
      provider = {
        type: 'cloudflare',
        name: customName.trim(),
        apiKey: customApiKey.trim(),
        accountId: customAccountId.trim(),
        ...(customBaseURL?.trim() && { baseURL: customBaseURL.trim() }),
        ...(customBaseDomain?.trim() && { baseDomain: customBaseDomain.trim() }),
        ...(customProxy && { proxy: true }),
      };
    } else if (customProviderType === 'deno') {
      if (!customApiKey.trim() || !customOrganizationId.trim()) return;
      provider = {
        type: 'deno',
        name: customName.trim(),
        apiKey: customApiKey.trim(),
        organizationId: customOrganizationId.trim(),
        ...(customBaseURL?.trim() && { baseURL: customBaseURL.trim() }),
        ...(customBaseDomain?.trim() && { baseDomain: customBaseDomain.trim() }),
        ...(customProxy && { proxy: true }),
      };
    } else if (customProviderType === 'railway') {
      if (!customApiKey.trim()) return;
      provider = {
        type: 'railway',
        name: customName.trim(),
        apiKey: customApiKey.trim(),
        ...(customBaseURL?.trim() && { baseURL: customBaseURL.trim() }),
        ...(customProxy && { proxy: true }),
      };
    } else {
      return; // Unknown type
    }

    onAdd(provider);

    // Reset form
    setCustomProviderType('');
    setCustomName('');
    setCustomApiKey('');
    setCustomAccountId('');
    setCustomOrganizationId('');
    setCustomBaseURL('');
    setCustomBaseDomain('');
    setCustomDashboardHost('');
    setCustomProxy(false);
    setCustomGateway('');
    setCustomRelayUrls([]);
    setCustomBlossomServers([]);

    onOpenChange(false);
  };

  const hasRequiredFields = () => {
    // A gateway is named by two hosts and reached with a Nostr key, so there is
    // no API key to ask for — but it cannot be guessed at either.
    if (customProviderType === 'npanel') {
      return Boolean(customDashboardHost.trim() && customGateway.trim());
    }
    // Plain nsite needs nothing beyond a name: it has defaults for the rest.
    if (customProviderType === 'nsite') return true;

    if (!customApiKey.trim()) return false;
    if (customProviderType === 'cloudflare') return Boolean(customAccountId.trim());
    if (customProviderType === 'deno') return Boolean(customOrganizationId.trim());
    return true;
  };

  const isValid = Boolean(customProviderType && customName.trim() && hasRequiredFields());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('addCustomProvider')}</DialogTitle>
          <DialogDescription>
            Configure a custom deployment provider with your own settings
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="custom-provider-type">
              {t('providerType')} <span className="text-destructive">*</span>
            </Label>
            <Select
              value={customProviderType}
              onValueChange={(value: 'npanel' | 'netlify' | 'vercel' | 'nsite' | 'cloudflare' | 'deno' | 'railway') => {
                setCustomProviderType(value);
                // Reset form when provider type changes
                setCustomApiKey('');
                setCustomAccountId('');
                setCustomOrganizationId('');
                setCustomBaseURL('');
                setCustomBaseDomain('');
                setCustomDashboardHost('');
                setCustomProxy(false);
                setCustomGateway('');
                setCustomRelayUrls([]);
                setCustomBlossomServers([]);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('selectProviderType')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="npanel">nsite gateway</SelectItem>
                <SelectItem value="nsite">nsite</SelectItem>
                <SelectItem value="netlify">Netlify</SelectItem>
                <SelectItem value="vercel">Vercel</SelectItem>
                <SelectItem value="cloudflare">Cloudflare</SelectItem>
                <SelectItem value="deno">Deno Deploy</SelectItem>
                <SelectItem value="railway">Railway</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {customProviderType && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="custom-name">
                  {t('providerName')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="custom-name"
                  placeholder="e.g., My Production Deploy"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </div>

              {customProviderType === 'npanel' ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t('shakespeareDeployNostrAuth')}
                  </p>
                  <div className="grid gap-2">
                    <Label htmlFor="custom-domain">
                      Domain <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="custom-domain"
                      placeholder="shakespeare.wtf"
                      value={customGateway}
                      onChange={(e) => setCustomGateway(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Sites get a name under this domain.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="custom-dashboard-host">
                      Gateway API <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="custom-dashboard-host"
                      placeholder="npanel.shakespeare.to"
                      value={customDashboardHost}
                      onChange={(e) => setCustomDashboardHost(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Where names are claimed. Usually a different host from the one above.
                    </p>
                  </div>
                  <UrlListEditor
                    label="Relay URLs"
                    items={customRelayUrls}
                    onChange={setCustomRelayUrls}
                    protocol="wss"
                    placeholder="relay.ditto.pub"
                  />
                  <UrlListEditor
                    label="Blossom Servers"
                    items={customBlossomServers}
                    onChange={setCustomBlossomServers}
                    protocol="https"
                    placeholder="blossom.ditto.pub"
                  />
                </>
              ) : customProviderType === 'nsite' ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Deploy to Nostr as a static website. Uses a kind 15128 site manifest event and Blossom file storage.
                  </p>
                  <div className="grid gap-2">
                    <Label htmlFor="custom-gateway">Gateway</Label>
                    <Input
                      id="custom-gateway"
                       placeholder="shakespeare.to"
                      value={customGateway}
                      onChange={(e) => setCustomGateway(e.target.value)}
                    />
                  </div>
                  <UrlListEditor
                    label="Relay URLs"
                    items={customRelayUrls}
                    onChange={setCustomRelayUrls}
                    protocol="wss"
                    placeholder="relay.ditto.pub"
                  />
                  <UrlListEditor
                    label="Blossom Servers"
                    items={customBlossomServers}
                    onChange={setCustomBlossomServers}
                    protocol="https"
                    placeholder="blossom.ditto.pub"
                  />
                </>
              ) : (
                <>
                  {customProviderType === 'cloudflare' && (
                    <div className="grid gap-2">
                      <Label htmlFor="custom-accountid">
                        Account ID <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="custom-accountid"
                        placeholder="Enter Account ID"
                        value={customAccountId}
                        onChange={(e) => setCustomAccountId(e.target.value)}
                      />
                    </div>
                  )}
                  {customProviderType === 'deno' && (
                    <div className="grid gap-2">
                      <Label htmlFor="custom-organizationid">
                        Organization ID <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="custom-organizationid"
                        placeholder="Enter Organization ID"
                        value={customOrganizationId}
                        onChange={(e) => setCustomOrganizationId(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label htmlFor="custom-apikey">
                      {customProviderType === 'netlify' ? 'Personal Access Token' :
                        customProviderType === 'cloudflare' ? 'API Token' :
                          customProviderType === 'deno' ? 'Access Token' :
                            customProviderType === 'railway' ? 'API Token' :
                              'Access Token'} <span className="text-destructive">*</span>
                    </Label>
                    <PasswordInput
                      id="custom-apikey"
                      placeholder={t('enterApiKey')}
                      value={customApiKey}
                      onChange={(e) => setCustomApiKey(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="custom-baseurl">Base URL (Optional)</Label>
                    <Input
                      id="custom-baseurl"
                      placeholder={
                        customProviderType === 'netlify'
                          ? 'https://api.netlify.com/api/v1'
                          : customProviderType === 'vercel'
                            ? 'https://api.vercel.com'
                            : customProviderType === 'deno'
                              ? 'https://api.deno.com/v1'
                              : customProviderType === 'railway'
                                ? 'https://backboard.railway.com'
                                : 'https://api.cloudflare.com/client/v4'
                      }
                      value={customBaseURL}
                      onChange={(e) => setCustomBaseURL(e.target.value)}
                    />
                  </div>
                  {(customProviderType === 'cloudflare' || customProviderType === 'deno') && (
                    <div className="grid gap-2">
                      <Label htmlFor="custom-basedomain">Base Domain (Optional)</Label>
                      <Input
                        id="custom-basedomain"
                        placeholder={customProviderType === 'cloudflare' ? 'workers.dev' : 'deno.dev'}
                        value={customBaseDomain}
                        onChange={(e) => setCustomBaseDomain(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {customProviderType === 'cloudflare'
                          ? 'The domain suffix for deployed workers (e.g., workers.dev)'
                          : 'The domain suffix for deployed projects (e.g., deno.dev)'}
                      </p>
                    </div>
                  )}
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="custom-proxy"
                      checked={customProxy}
                      onCheckedChange={(checked) => setCustomProxy(checked === true)}
                    />
                    <Label htmlFor="custom-proxy" className="text-sm font-normal cursor-pointer">
                      Use CORS Proxy
                    </Label>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={handleAdd} disabled={!isValid}>
            <Check className="h-4 w-4 mr-2" />
            {t('add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
