import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket, Plus, GripVertical } from 'lucide-react';
import { SettingsPageLayout } from '@/components/SettingsPageLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeploySettings } from '@/hooks/useDeploySettings';
import { useNetlifyOAuth } from '@/hooks/useNetlifyOAuth';
import { useVercelOAuth } from '@/hooks/useVercelOAuth';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { DeployProvider, NpanelProvider } from '@/contexts/DeploySettingsContext';
import type { PresetDeployProvider } from '@/lib/deploy/types';
import { PRESET_DEPLOY_PROVIDERS, DEFAULT_NPANEL_PROVIDER, DEFAULT_NSITE_PROVIDER } from '@/lib/deployProviderPresets';
import { ExternalFavicon } from '@/components/ExternalFavicon';
import { ProviderConfigDialog } from '@/components/ProviderConfigDialog';
import { AddDeployProviderDialog } from '@/components/AddDeployProviderDialog';
import { AddCustomProviderDialog } from '@/components/AddCustomProviderDialog';
import { NpanelMigrationDialog } from '@/components/deploy/NpanelMigrationDialog';
import { useNpanelClaimCount } from '@/hooks/useNpanelClaims';
import { Button } from '@/components/ui/button';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ProviderTileProps {
  provider: DeployProvider;
  preset?: PresetDeployProvider;
  onClick: () => void;
  id: string;
}

function ProviderTile({ provider, preset, onClick, id }: ProviderTileProps) {
  // Use baseURL from configured provider, falling back to preset baseURL
  const baseURL = ('baseURL' in provider && provider.baseURL) || preset?.baseURL;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group">
      <button
        onClick={onClick}
        className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border bg-card hover:bg-muted transition-colors text-center h-[120px] w-full"
      >
        <ExternalFavicon
          url={baseURL}
          size={32}
          fallback={<Rocket size={32} />}
        />
        <span className="text-sm font-medium line-clamp-2 overflow-hidden max-w-full text-ellipsis">
          {provider.name}
        </span>
      </button>
      <div
        {...attributes}
        {...listeners}
        className="absolute top-1 right-1 p-1 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 rounded hover:bg-muted"
        title="Drag to reorder"
      >
        <GripVertical size={16} className="text-muted-foreground" />
      </div>
    </div>
  );
}

interface AddProviderTileProps {
  onClick: () => void;
}

function AddProviderTile({ onClick }: AddProviderTileProps) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border border-dashed bg-card hover:bg-muted transition-colors text-center min-h-[100px]"
    >
      <Plus size={32} className="text-muted-foreground" />
      <span className="text-sm font-medium text-muted-foreground overflow-hidden max-w-full text-ellipsis">
        Add Custom
      </span>
    </button>
  );
}

interface PresetProviderTileProps {
  preset: PresetDeployProvider;
  onClick: () => void;
}

function PresetProviderTile({ preset, onClick }: PresetProviderTileProps) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border bg-card hover:bg-muted transition-colors text-center min-h-[100px]"
    >
      <ExternalFavicon
        url={preset.baseURL}
        size={32}
        fallback={<Rocket size={32} />}
      />
      <span className="text-sm font-medium line-clamp-2 overflow-hidden max-w-full text-ellipsis">
        {preset.name}
      </span>
    </button>
  );
}

// Helper function to generate custom provider ID
function generateCustomProviderId(type: string): string {
  const uuid = crypto.randomUUID();
  const randomSegment = uuid.split('-')[0];
  return `${type}-${randomSegment}`;
}

export function DeploySettings() {
  const { t } = useTranslation();
  const { settings, removeProvider, setProviders, isInitialized } = useDeploySettings();
  const { user } = useCurrentUser();

  // OAuth hooks
  const netlifyOAuth = useNetlifyOAuth();
  const vercelOAuth = useVercelOAuth();

  const [forceManualEntry, setForceManualEntry] = useState<Record<string, boolean>>({});

  // Dialog state
  const [selectedProviderIndex, setSelectedProviderIndex] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<PresetDeployProvider | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [customProviderDialogOpen, setCustomProviderDialogOpen] = useState(false);
  const [migratingProvider, setMigratingProvider] = useState<NpanelProvider | null>(null);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = settings.providers.findIndex((p) => p.id === active.id);
      const newIndex = settings.providers.findIndex((p) => p.id === over.id);

      const newProviders = arrayMove(settings.providers, oldIndex, newIndex);
      setProviders(newProviders);
    }
  };

  const handleOpenProviderDialog = (index: number) => {
    setSelectedProviderIndex(index);
    setDialogOpen(true);
  };

  const handleOpenAddDialog = (preset: PresetDeployProvider) => {
    setSelectedPreset(preset);
    setAddDialogOpen(true);
  };

  const handleAddPresetProvider = (preset: PresetDeployProvider, apiKey: string, accountId?: string, organizationId?: string) => {
    // Nostr-authenticated providers need a login rather than a key
    if (preset.requiresNostr && !user) {
      return;
    }

    // Everything else is reached with an API key, except plain nsite
    if (!preset.requiresNostr && preset.type !== 'nsite' && !apiKey?.trim()) {
      return;
    }

    let newProvider: DeployProvider;

    if (preset.type === 'npanel') {
      newProvider = { ...DEFAULT_NPANEL_PROVIDER, id: preset.id, name: preset.name };
    } else if (preset.type === 'nsite') {
      newProvider = { ...DEFAULT_NSITE_PROVIDER };
    } else if (preset.type === 'netlify') {
      newProvider = {
        id: preset.id, // Use preset ID for presets
        name: preset.name,
        type: 'netlify',
        apiKey: apiKey.trim(),
        ...(preset.proxy && { proxy: true }),
      };
    } else if (preset.type === 'vercel') {
      newProvider = {
        id: preset.id, // Use preset ID for presets
        name: preset.name,
        type: 'vercel',
        apiKey: apiKey.trim(),
        ...(preset.proxy && { proxy: true }),
      };
    } else if (preset.type === 'cloudflare') {
      if (!accountId?.trim()) {
        return;
      }
      newProvider = {
        id: preset.id, // Use preset ID for presets
        name: preset.name,
        type: 'cloudflare',
        apiKey: apiKey.trim(),
        accountId: accountId.trim(),
        ...(preset.proxy && { proxy: true }),
      };
    } else if (preset.type === 'deno') {
      if (!organizationId?.trim()) {
        return;
      }
      newProvider = {
        id: preset.id, // Use preset ID for presets
        name: preset.name,
        type: 'deno',
        apiKey: apiKey.trim(),
        organizationId: organizationId.trim(),
        ...(preset.proxy && { proxy: true }),
      };
    } else if (preset.type === 'railway') {
      newProvider = {
        id: preset.id, // Use preset ID for presets
        name: preset.name,
        type: 'railway',
        apiKey: apiKey.trim(),
        ...(preset.proxy && { proxy: true }),
      };
    } else {
      return; // Unknown type
    }

    setProviders([...settings.providers, newProvider]);
  };

  const handleAddCustomProvider = (provider: Omit<DeployProvider, 'id'>) => {
    const newProvider: DeployProvider = {
      id: generateCustomProviderId(provider.type),
      ...provider,
    } as DeployProvider;

    setProviders([...settings.providers, newProvider]);
  };

  const handleRemoveProvider = (index: number) => {
    removeProvider(index);
    setSelectedProviderIndex(null);
  };

  const handleUpdateProvider = (index: number, provider: DeployProvider) => {
    const newProviders = [...settings.providers];
    newProviders[index] = provider;
    setProviders(newProviders);
  };

  const configuredProviderIds = settings.providers.map(p => p.id);
  const availablePresets = PRESET_DEPLOY_PROVIDERS.filter(preset => !configuredProviderIds.includes(preset.id));

  return (
    <SettingsPageLayout
      icon={Rocket}
      titleKey="deploySettings"
      descriptionKey="deploySettingsDescription"
    >
      {!isInitialized ? (
        <>
          {/* Loading skeleton for configured providers */}
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
              <Skeleton className="h-[120px] w-full rounded-lg" />
              <Skeleton className="h-[120px] w-full rounded-lg" />
            </div>
          </div>

          {/* Loading skeleton for add provider section */}
          <div className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
              <Skeleton className="h-[120px] w-full rounded-lg" />
              <Skeleton className="h-[120px] w-full rounded-lg" />
              <Skeleton className="h-[120px] w-full rounded-lg" />
              <Skeleton className="h-[120px] w-full rounded-lg" />
              <Skeleton className="h-[120px] w-full rounded-lg" />
              <Skeleton className="h-[120px] w-full rounded-lg" />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Configured Providers */}
          {settings.providers.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium">{t('configuredProviders')}</h4>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={settings.providers.map((p) => p.id)}
                  strategy={rectSortingStrategy}
                >
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
                    {settings.providers.map((provider, index) => {
                      const preset = PRESET_DEPLOY_PROVIDERS.find(p => p.type === provider.type);

                      return (
                        <ProviderTile
                          key={provider.id}
                          id={provider.id}
                          provider={provider}
                          preset={preset}
                          onClick={() => handleOpenProviderDialog(index)}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {user && settings.providers.map((provider) => (
            provider.type === 'npanel' ? (
              <HeldSites
                key={`migrate-${provider.id}`}
                provider={provider}
                onOpen={() => setMigratingProvider(provider)}
              />
            ) : null
          ))}

          {migratingProvider && (
            <NpanelMigrationDialog
              open
              onOpenChange={(open) => !open && setMigratingProvider(null)}
              provider={migratingProvider}
            />
          )}

          {/* Provider Config Dialog */}
          {selectedProviderIndex !== null && settings.providers[selectedProviderIndex] && (
            <ProviderConfigDialog
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              provider={settings.providers[selectedProviderIndex]}
              preset={PRESET_DEPLOY_PROVIDERS.find(p => p.type === settings.providers[selectedProviderIndex].type)}
              onUpdate={(updatedProvider) => handleUpdateProvider(selectedProviderIndex, updatedProvider)}
              onRemove={() => handleRemoveProvider(selectedProviderIndex)}
            />
          )}

          {/* Available Preset Providers */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium">{t('addProvider')}</h4>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
              {availablePresets.map((preset) => (
                <PresetProviderTile
                  key={preset.id}
                  preset={preset}
                  onClick={() => handleOpenAddDialog(preset)}
                />
              ))}

              {/* Add Custom Provider Tile */}
              <AddProviderTile onClick={() => setCustomProviderDialogOpen(true)} />
            </div>

            {/* Add Preset Provider Dialog */}
            {selectedPreset && (
              <AddDeployProviderDialog
                open={addDialogOpen}
                onOpenChange={setAddDialogOpen}
                preset={selectedPreset}
                isLoggedIntoNostr={!!user}
                oauthHook={
                  selectedPreset.type === 'netlify' ? netlifyOAuth :
                    selectedPreset.type === 'vercel' ? vercelOAuth : null
                }
                forceManualEntry={forceManualEntry[selectedPreset.id] || false}
                onSetForceManualEntry={(force) =>
                  setForceManualEntry(prev => ({ ...prev, [selectedPreset.id]: force }))
                }
                onAdd={(apiKey, accountId, organizationId) =>
                  handleAddPresetProvider(selectedPreset, apiKey, accountId, organizationId)
                }
              />
            )}

            {/* Add Custom Provider Dialog */}
            <AddCustomProviderDialog
              open={customProviderDialogOpen}
              onOpenChange={setCustomProviderDialogOpen}
              onAdd={handleAddCustomProvider}
            />
          </div>


        </>
      )}
    </SettingsPageLayout>
  );
}

/**
 * Sites held for their previous owner on a gateway that took over a domain.
 *
 * The count is asked for on load, rather than the card standing there saying
 * "you may have sites waiting" to everyone forever. Almost nobody does, and a
 * card that cannot tell them apart is one most people learn to ignore before
 * it ever applies to them — while the person it does apply to has a few names
 * being served from an archive under a key that is not theirs, which is worth
 * one signature to say out loud.
 *
 * It is only the count: {@link useNpanelClaimCount} is two counted rows, not
 * the deploy-by-deploy read the dialog does when somebody opens it.
 */
function HeldSites({ provider, onOpen }: { provider: NpanelProvider; onOpen: () => void }) {
  const { data } = useNpanelClaimCount(provider);

  // Nothing to say until the gateway says there is something, so a gateway with
  // no migration behind it — every gateway but the one — shows nothing at all.
  if (!data?.waiting) return null;

  return (
    <div className="rounded-lg border border-dashed p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">
          {data.waiting === 1
            ? `One name is waiting for you on ${provider.domain}`
            : `${data.waiting} names are waiting for you on ${provider.domain}`}
        </h4>
        <p className="text-sm text-muted-foreground">
          You published {data.waiting === 1 ? 'it' : 'them'} before {provider.domain} moved to{' '}
          {provider.name}. {data.waiting === 1 ? 'It is' : 'They are'} being served from an archive
          until you take {data.waiting === 1 ? 'it' : 'them'} back.
        </p>
      </div>
      <Button variant="outline" onClick={onOpen}>
        Take back sites
      </Button>
    </div>
  );
}

export default DeploySettings;
