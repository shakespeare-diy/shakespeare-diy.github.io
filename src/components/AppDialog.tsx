import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useToast } from '@/hooks/useToast';
import { useFS } from '@/hooks/useFS';
import { useFSPaths } from '@/hooks/useFSPaths';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useAppEvent } from '@/hooks/useAppEvent';
import { useProjectDeploySettings } from '@/hooks/useProjectDeploySettings';
import { useQueryClient } from '@tanstack/react-query';
import { DotAI } from '@/lib/DotAI';
import { buildAppEvent } from '@/lib/appEvent';
import {
  Loader2,
  Save,
  Plus,
  X,
  ExternalLink,
  Pencil,
  ChevronDown,
  CircleHelp,
} from 'lucide-react';
import type { NostrEvent } from '@nostrify/nostrify';

interface AppDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AppFormData {
  name: string;
  about: string;
  picture: string;
  banner: string;
  website: string;
  dTag: string;
  supportedKinds: string[];
  webHandlers: Array<{ url: string; type: string }>;
}

/** Parse a kind 31990 event into form data */
function eventToFormData(event: NostrEvent): AppFormData {
  let metadata: Record<string, string> = {};
  try {
    if (event.content) {
      metadata = JSON.parse(event.content);
    }
  } catch {
    // Invalid JSON content, use empty metadata
  }

  const dTag = event.tags.find(([t]) => t === 'd')?.[1] ?? '';
  const supportedKinds = event.tags
    .filter(([t]) => t === 'k')
    .map(([, v]) => v)
    .filter(Boolean);

  const webHandlers = event.tags
    .filter(([t]) => t === 'web')
    .map(([, url, type]) => ({ url: url ?? '', type: type ?? '' }));

  return {
    name: metadata.name ?? '',
    about: metadata.about ?? '',
    picture: metadata.picture ?? '',
    banner: metadata.banner ?? '',
    website: metadata.website ?? '',
    dTag,
    supportedKinds,
    webHandlers,
  };
}

/** Convert a slug like "my-cool-app" to title case like "My Cool App" */
function toTitleCase(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Create empty form data for a new app */
function emptyFormData(projectId: string): AppFormData {
  return {
    name: toTitleCase(projectId),
    about: '',
    picture: '',
    banner: '',
    website: '',
    dTag: projectId,
    supportedKinds: [],
    webHandlers: [],
  };
}

export function AppDialog({ projectId, open, onOpenChange }: AppDialogProps) {
  const { fs } = useFS();
  const { projectsPath } = useFSPaths();
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploading } = useUploadFile();
  const cwd = `${projectsPath}/${projectId}`;

  const { event, isLoading, aTag, hasApp, refetch } = useAppEvent({ cwd });
  const { settings: deploySettings, isLoading: isDeployLoading } = useProjectDeploySettings(projectId);

  const [formData, setFormData] = useState<AppFormData>(emptyFormData(projectId));
  const [isSaving, setIsSaving] = useState(false);
  const [newKind, setNewKind] = useState('');
  const [newHandlerUrl, setNewHandlerUrl] = useState('');
  const [newHandlerType, setNewHandlerType] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);

  // Get the deployed URL from project deploy settings
  const deployedUrl = (() => {
    if (!deploySettings?.currentProvider || !deploySettings?.providers) return null;
    const config = deploySettings.providers[deploySettings.currentProvider];
    return config?.url ?? null;
  })();

  // Populate form when event loads
  useEffect(() => {
    if (event) {
      setFormData(eventToFormData(event));
    } else if (!isLoading && !hasApp) {
      setFormData(emptyFormData(projectId));
    }
  }, [event, isLoading, hasApp, projectId]);

  // Auto-fill website from deployment URL when creating a new app (not editing existing)
  useEffect(() => {
    if (!hasApp && !isDeployLoading && deployedUrl && !formData.website) {
      setFormData(prev => ({ ...prev, website: deployedUrl }));
    }
  }, [hasApp, isDeployLoading, deployedUrl, formData.website]);

  const updateField = useCallback(<K extends keyof AppFormData>(key: K, value: AppFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  }, []);

  const addKind = useCallback(() => {
    const kind = newKind.trim();
    if (kind && !formData.supportedKinds.includes(kind)) {
      updateField('supportedKinds', [...formData.supportedKinds, kind]);
      setNewKind('');
    }
  }, [newKind, formData.supportedKinds, updateField]);

  const removeKind = useCallback((kind: string) => {
    updateField('supportedKinds', formData.supportedKinds.filter(k => k !== kind));
  }, [formData.supportedKinds, updateField]);

  const addHandler = useCallback(() => {
    const url = newHandlerUrl.trim();
    if (url) {
      updateField('webHandlers', [...formData.webHandlers, { url, type: newHandlerType.trim() }]);
      setNewHandlerUrl('');
      setNewHandlerType('');
    }
  }, [newHandlerUrl, newHandlerType, formData.webHandlers, updateField]);

  const removeHandler = useCallback((index: number) => {
    updateField('webHandlers', formData.webHandlers.filter((_, i) => i !== index));
  }, [formData.webHandlers, updateField]);

  const handleBannerUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const tags = await uploadFile(file);
      const url = tags[0]?.[1];
      if (url) {
        updateField('banner', url);
        toast({ title: 'Banner uploaded', description: 'Your app banner has been uploaded.' });
      }
    } catch (error) {
      toast({
        title: 'Upload failed',
        description: error instanceof Error ? error.message : 'Failed to upload banner.',
        variant: 'destructive',
      });
    } finally {
      if (bannerFileInputRef.current) {
        bannerFileInputRef.current.value = '';
      }
    }
  }, [uploadFile, updateField, toast]);

  const handleIconUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const tags = await uploadFile(file);
      const url = tags[0]?.[1];
      if (url) {
        updateField('picture', url);
        toast({ title: 'Icon uploaded', description: 'Your app icon has been uploaded.' });
      }
    } catch (error) {
      toast({
        title: 'Upload failed',
        description: error instanceof Error ? error.message : 'Failed to upload icon.',
        variant: 'destructive',
      });
    } finally {
      // Reset input so re-selecting the same file triggers onChange
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [uploadFile, updateField, toast]);

  const handleSave = async () => {
    if (!user) {
      toast({
        title: 'Not logged in',
        description: 'You must be logged in with Nostr to publish an app.',
        variant: 'destructive',
      });
      return;
    }

    if (!formData.name.trim()) {
      toast({
        title: 'Name required',
        description: 'Please enter a name for your app.',
        variant: 'destructive',
      });
      return;
    }

    if (!formData.about.trim()) {
      toast({
        title: 'Description required',
        description: 'Please enter a description for your app.',
        variant: 'destructive',
      });
      return;
    }

    if (!formData.website.trim()) {
      toast({
        title: 'Website required',
        description: 'Please enter a website URL for your app.',
        variant: 'destructive',
      });
      return;
    }

    if (!formData.picture.trim()) {
      toast({
        title: 'Icon required',
        description: 'Please upload an icon for your app.',
        variant: 'destructive',
      });
      return;
    }

    if (!formData.banner.trim()) {
      toast({
        title: 'Banner required',
        description: 'Please upload a banner image for your app.',
        variant: 'destructive',
      });
      return;
    }

    if (!formData.dTag.trim()) {
      toast({
        title: 'Identifier required',
        description: 'Please enter a unique identifier (d-tag) for your app.',
        variant: 'destructive',
      });
      return;
    }

    setIsSaving(true);

    try {
      // Build event content and tags
      const { content, tags } = await buildAppEvent(
        {
          name: formData.name,
          about: formData.about,
          picture: formData.picture,
          banner: formData.banner,
          website: formData.website,
          dTag: formData.dTag,
          supportedKinds: formData.supportedKinds,
          webHandlers: formData.webHandlers,
        },
        { fs, cwd, pubkey: user.pubkey },
      );

      // Publish the event
      const published = await publishEvent({
        kind: 31990,
        content,
        tags,
      });

      // Store the "a" coordinate in .git/shakespeare/app.json
      const aValue = `31990:${published.pubkey}:${formData.dTag.trim()}`;
      const dotAI = new DotAI(fs, cwd);
      await dotAI.writeAppConfig({ a: aValue });

      // Invalidate queries
      await queryClient.invalidateQueries({ queryKey: ['app-event'] });
      await refetch();

      toast({
        title: hasApp ? 'App updated' : 'App published',
        description: `"${formData.name}" has been ${hasApp ? 'updated' : 'published'} to Nostr.`,
      });

      onOpenChange(false);
    } catch (error) {
      console.error('Failed to publish app:', error);
      toast({
        title: 'Failed to publish',
        description: error instanceof Error ? error.message : 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (!user) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>App</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You must be logged in with Nostr to manage your app.
          </p>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{hasApp ? 'Edit App' : 'Publish App'}</DialogTitle>
          <DialogDescription>
            {hasApp
              ? 'Update your app\'s listing on Nostr.'
              : 'Publish your project as a Nostr app.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <Skeleton className="h-20 w-20 rounded-2xl flex-shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* App Preview Card — banner + overlapping icon */}
            <div className="border rounded-xl overflow-hidden bg-card">
              {/* Hidden file inputs */}
              <input
                ref={bannerFileInputRef}
                type="file"
                accept="image/*"
                onChange={handleBannerUpload}
                className="hidden"
                disabled={isSaving || isUploading}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleIconUpload}
                className="hidden"
                disabled={isSaving || isUploading}
              />

              {/* Banner */}
              <div
                className="relative h-32 bg-muted cursor-pointer group"
                style={formData.banner ? { backgroundImage: `url(${formData.banner})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
                onClick={() => !isSaving && !isUploading && bannerFileInputRef.current?.click()}
              >
                {!formData.banner && (
                  <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-primary/5" />
                )}
                {!formData.banner && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Plus className="h-6 w-6 text-muted-foreground" strokeWidth={3} />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 text-white text-xs font-medium bg-black/50 rounded-full px-3 py-1.5 backdrop-blur-sm">
                    {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
                    {formData.banner ? 'Change banner' : 'Add banner'}
                  </span>
                </div>
                <div className="absolute bottom-2 right-2 h-7 w-7 rounded-full bg-background border border-border shadow-sm flex items-center justify-center">
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>

              {/* Icon + Name/Description */}
              <div className="px-4 pb-4">
                {/* Icon overlapping banner */}
                <div className="-mt-10 mb-3">
                  <div className="relative inline-block group cursor-pointer" onClick={() => !isSaving && !isUploading && fileInputRef.current?.click()}>
                    <Avatar className="h-20 w-20 rounded-2xl border-4 border-background shadow-sm">
                      <AvatarImage src={formData.picture} alt={formData.name || 'App icon'} className="object-cover" />
                      <AvatarFallback className="rounded-2xl bg-muted">
                        {formData.picture ? null : <Plus className="h-7 w-7 text-muted-foreground" strokeWidth={3} />}
                      </AvatarFallback>
                    </Avatar>
                    <div className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                      <Pencil className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                    </div>
                    <div className="absolute bottom-0 right-0 h-6 w-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center">
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </div>
                  </div>
                </div>

                {/* Name & Description */}
                <div className="space-y-2">
                  <Input
                    value={formData.name}
                    onChange={e => updateField('name', e.target.value)}
                    placeholder="App Name"
                    disabled={isSaving}
                  />
                  <Textarea
                    value={formData.about}
                    onChange={e => updateField('about', e.target.value)}
                    placeholder="A short description of your app..."
                    rows={2}
                    disabled={isSaving}
                    className="resize-none"
                  />
                </div>

                {/* Website */}
                <div className="mt-3">
                  <Input
                    id="app-website"
                    value={formData.website}
                    onChange={e => updateField('website', e.target.value)}
                    placeholder={deployedUrl || 'https://myapp.example.com'}
                    disabled={isSaving}
                    className="text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Advanced Section */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-2 border-t"
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                  <span>Advanced</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-4 pt-2">
                  {/* Hint to use AI */}
                  <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
                    <CircleHelp className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    <span>Not sure? Ask Shakespeare to update your app.</span>
                  </div>

                  {/* Identifier (d-tag) */}
                  <div className="space-y-1.5">
                    <Label htmlFor="app-dtag" className="text-xs">Identifier</Label>
                    <Input
                      id="app-dtag"
                      value={formData.dTag}
                      onChange={e => updateField('dTag', e.target.value)}
                      placeholder="my-app"
                      disabled={isSaving || hasApp}
                    />
                    <p className="text-xs text-muted-foreground">
                      {hasApp ? 'Cannot be changed after publishing.' : 'Unique identifier for this app. Defaults to the project ID.'}
                    </p>
                  </div>

                  {/* Supported Kinds */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Supported Event Kinds</Label>
                    {formData.supportedKinds.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {formData.supportedKinds.map(kind => (
                          <Badge key={kind} variant="secondary" className="gap-1">
                            {kind}
                            <button
                              onClick={() => removeKind(kind)}
                              disabled={isSaving}
                              className="hover:text-destructive"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        value={newKind}
                        onChange={e => setNewKind(e.target.value)}
                        placeholder="Kind number (e.g. 1)"
                        disabled={isSaving}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addKind();
                          }
                        }}
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={addKind}
                        disabled={isSaving || !newKind.trim()}
                        className="h-9"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Web Handlers */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">Web Handlers</Label>
                    {formData.webHandlers.length > 0 && (
                      <div className="space-y-1.5">
                        {formData.webHandlers.map((handler, index) => (
                          <div key={index} className="flex items-center gap-2 text-sm bg-muted/50 p-2 rounded-md">
                            <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            <span className="truncate flex-1">{handler.url}</span>
                            {handler.type && (
                              <Badge variant="outline" className="text-xs flex-shrink-0">{handler.type}</Badge>
                            )}
                            <button
                              onClick={() => removeHandler(index)}
                              disabled={isSaving}
                              className="hover:text-destructive flex-shrink-0"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        value={newHandlerUrl}
                        onChange={e => setNewHandlerUrl(e.target.value)}
                        placeholder="https://app.example.com/e/<bech32>"
                        disabled={isSaving}
                        className="flex-1"
                      />
                      <Select
                        value={newHandlerType}
                        onValueChange={setNewHandlerType}
                        disabled={isSaving}
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue placeholder="Type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="npub">npub</SelectItem>
                          <SelectItem value="note">note</SelectItem>
                          <SelectItem value="nprofile">nprofile</SelectItem>
                          <SelectItem value="nevent">nevent</SelectItem>
                          <SelectItem value="naddr">naddr</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={addHandler}
                        disabled={isSaving || !newHandlerUrl.trim()}
                        className="h-9"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      URL patterns where <code className="text-xs">{'<bech32>'}</code> will be replaced with the NIP-19 entity.
                    </p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Save Button */}
            <Button
              onClick={handleSave}
              disabled={isSaving || !formData.name.trim() || !formData.about.trim() || !formData.website.trim() || !formData.picture.trim() || !formData.banner.trim()}
              className="w-full gap-2"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {isSaving
                ? (hasApp ? 'Updating...' : 'Publishing...')
                : (hasApp ? 'Update App' : 'Publish App')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
