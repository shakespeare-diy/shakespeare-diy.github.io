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
  Upload,
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
            {/* App Preview Card */}
            <div className="flex items-start gap-4">
              {/* Icon with upload */}
              <div className="relative flex-shrink-0 group">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleIconUpload}
                  className="hidden"
                  disabled={isSaving || isUploading}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSaving || isUploading}
                  className="relative block rounded-2xl overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none"
                >
                  {formData.picture ? (
                    <>
                      <Avatar className="h-20 w-20 rounded-2xl">
                        <AvatarImage src={formData.picture} alt={formData.name || 'App icon'} className="object-cover" />
                        <AvatarFallback className="rounded-2xl bg-muted" />
                      </Avatar>
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl">
                        {isUploading ? (
                          <Loader2 className="h-5 w-5 text-white animate-spin" />
                        ) : (
                          <Pencil className="h-4 w-4 text-white" />
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="h-20 w-20 rounded-2xl bg-muted flex items-center justify-center transition-colors group-hover:bg-muted-foreground">
                      {isUploading ? (
                        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin group-hover:text-background" />
                      ) : (
                        <Upload className="h-6 w-6 text-muted-foreground transition-colors group-hover:text-background" />
                      )}
                    </div>
                  )}
                </button>
              </div>

              {/* Name & Description inline */}
              <div className="flex-1 min-w-0 space-y-2">
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
            </div>

            {/* Website */}
            <div className="space-y-1.5">
              <Label htmlFor="app-website" className="text-xs text-muted-foreground">Website</Label>
              <Input
                id="app-website"
                value={formData.website}
                onChange={e => updateField('website', e.target.value)}
                placeholder={deployedUrl || 'https://myapp.example.com'}
                disabled={isSaving}
              />
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
                      <Input
                        value={newHandlerType}
                        onChange={e => setNewHandlerType(e.target.value)}
                        placeholder="nevent"
                        disabled={isSaving}
                        className="w-24"
                      />
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
              disabled={isSaving || !formData.name.trim()}
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
