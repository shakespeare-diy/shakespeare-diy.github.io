import type { AISettings } from '@/contexts/AISettingsContext';
import { AI_PROVIDER_PRESETS } from '@/lib/aiProviderPresets';

const opencodePreset = AI_PROVIDER_PRESETS.find((p) => p.id === 'opencode')!;

/** Empty AI settings used as initial state and error fallback. Won't overwrite user data. */
export const EMPTY_AI_SETTINGS: AISettings = {
  providers: [],
  recentlyUsedModels: [],
  mcpServers: {},
};

/** Default AI settings with OpenCode Zen pre-configured and big-pickle selected. Only for genuinely new users. */
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
