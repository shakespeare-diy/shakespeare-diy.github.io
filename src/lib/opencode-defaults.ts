import type { AISettings } from '@/contexts/AISettingsContext';
import { AI_PROVIDER_PRESETS } from '@/lib/aiProviderPresets';

const opencodePreset = AI_PROVIDER_PRESETS.find((p) => p.id === 'opencode')!;

/** Default AI settings with OpenCode Zen pre-configured and big-pickle selected. */
export const OPENCODE_DEFAULT_SETTINGS: AISettings = {
  providers: [
    {
      id: opencodePreset.id,
      name: opencodePreset.name,
      baseURL: opencodePreset.baseURL,
      proxy: opencodePreset.proxy,
    },
  ],
  recentlyUsedModels: ['opencode/big-pickle'],
  mcpServers: {},
};
