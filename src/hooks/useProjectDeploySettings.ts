import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';
import { useFS } from './useFS';
import { useFSPaths } from './useFSPaths';

const npanelProjectConfigSchema = z.object({
  type: z.literal('npanel'),
  url: z.string(),
  data: z.object({
    /** The single label in front of the gateway's domain. */
    subdomain: z.string().optional(),
    siteTitle: z.string().optional(),
    siteDescription: z.string().optional(),
  }),
});

const nsiteProjectConfigSchema = z.object({
  type: z.literal('nsite'),
  url: z.string(),
  data: z.object({
    /** Kept optional — only present on configs created before the signer migration */
    nsec: z.string().optional(),
    siteTitle: z.string().optional(),
    siteDescription: z.string().optional(),
    /** Named-site dTag identifier (kind 35128). */
    dTag: z.string().optional(),
    /** @deprecated — Shakespeare always deploys named sites now. Kept for backward compat. */
    siteType: z.enum(['named', 'root']).optional(),
  }),
});

const netlifyProjectConfigSchema = z.object({
  type: z.literal('netlify'),
  url: z.string(),
  data: z.object({
    siteId: z.string().optional(),
  }),
});

const vercelProjectConfigSchema = z.object({
  type: z.literal('vercel'),
  url: z.string(),
  data: z.object({
    teamId: z.string().optional(),
    projectId: z.string().optional(),
  }),
});

const cloudflareProjectConfigSchema = z.object({
  type: z.literal('cloudflare'),
  url: z.string(),
  data: z.object({
    projectName: z.string().optional(),
  }),
});

const denoDeployProjectConfigSchema = z.object({
  type: z.literal('deno'),
  url: z.string(),
  data: z.object({
    projectName: z.string().optional(),
  }),
});

const railwayProjectConfigSchema = z.object({
  type: z.literal('railway'),
  url: z.string(),
  data: z.object({
    workspaceId: z.string().optional(),
    projectId: z.string().optional(),
    environmentId: z.string().optional(),
    serviceId: z.string().optional(),
  }),
});

const projectProviderConfigSchema = z.discriminatedUnion('type', [
  npanelProjectConfigSchema,
  nsiteProjectConfigSchema,
  netlifyProjectConfigSchema,
  vercelProjectConfigSchema,
  cloudflareProjectConfigSchema,
  denoDeployProjectConfigSchema,
  railwayProjectConfigSchema,
]);

const projectDeploySettingsSchema = z.object({
  providers: z.record(z.string(), projectProviderConfigSchema),
  currentProvider: z.string().optional(),
});

export type NpanelProjectConfig = z.infer<typeof npanelProjectConfigSchema>;
export type NsiteProjectConfig = z.infer<typeof nsiteProjectConfigSchema>;
export type NetlifyProjectConfig = z.infer<typeof netlifyProjectConfigSchema>;
export type VercelProjectConfig = z.infer<typeof vercelProjectConfigSchema>;
export type CloudflareProjectConfig = z.infer<typeof cloudflareProjectConfigSchema>;
export type DenoDeployProjectConfig = z.infer<typeof denoDeployProjectConfigSchema>;
export type RailwayProjectConfig = z.infer<typeof railwayProjectConfigSchema>;
export type ProjectProviderConfig = z.infer<typeof projectProviderConfigSchema>;
export type ProjectDeploySettings = z.infer<typeof projectDeploySettingsSchema>;

/**
 * Bring a record written by an older version up to date.
 *
 * `shakespeare` deploys became `npanel` ones against the same domain, and the
 * subdomain carries straight over. Worth doing rather than letting the schema
 * reject it: this file holds one record per provider a project has ever
 * deployed to, so a single unparseable entry would take a Netlify site id and a
 * Vercel project id down with it.
 */
function migrateProjectProviderConfig(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config;

  const candidate = config as Record<string, unknown>;
  if (candidate.type !== 'shakespeare') return config;

  return { ...candidate, type: 'npanel' };
}

/**
 * Hook to manage project-specific deployment settings
 * Stores settings in .git/shakespeare/deploy.json
 */
export function useProjectDeploySettings(projectId: string | null) {
  const fs = useFS();
  const { projectsPath } = useFSPaths();
  const [settings, setSettings] = useState<ProjectDeploySettings>({ providers: {} });
  const [isLoading, setIsLoading] = useState(true);

  const settingsPath = `${projectsPath}/${projectId}/.git/shakespeare/deploy.json`;

  const loadSettings = useCallback(async () => {
    // Don't try to load if projectId is falsy
    if (!projectId) {
      setSettings({ providers: {} });
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const content = await fs.fs.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(content as string) as { providers?: Record<string, unknown> };

      const migrated = {
        ...parsed,
        providers: Object.fromEntries(
          Object.entries(parsed?.providers ?? {}).map(([id, config]) => [
            id,
            migrateProjectProviderConfig(config),
          ]),
        ),
      };

      // Validate with Zod
      const validated = projectDeploySettingsSchema.parse(migrated);
      setSettings(validated);
    } catch (error) {
      // File doesn't exist, is invalid JSON, or doesn't match schema - use empty settings
      if (error instanceof Error && !error.message.includes('ENOENT')) {
        console.warn('Failed to load or validate deploy settings:', error);
      }
      setSettings({ providers: {} });
    } finally {
      setIsLoading(false);
    }
  }, [fs.fs, settingsPath, projectId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = async (newSettings: ProjectDeploySettings) => {
    if (!projectId) {
      throw new Error('Cannot save settings: no project selected');
    }

    try {
      // Ensure .git/shakespeare directory exists
      const shakespeareDir = `${projectsPath}/${projectId}/.git/shakespeare`;
      try {
        await fs.fs.stat(shakespeareDir);
      } catch {
        await fs.fs.mkdir(shakespeareDir, { recursive: true });
      }

      // Save settings
      await fs.fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2), 'utf8');
      setSettings(newSettings);
    } catch (error) {
      console.error('Failed to save deploy settings:', error);
      throw error;
    }
  };

  const updateSettings = async (providerId: string, config: ProjectProviderConfig) => {
    const newSettings = {
      ...settings,
      providers: { ...settings.providers, [providerId]: config },
      currentProvider: providerId,
    };
    await saveSettings(newSettings);
  };

  const getProviderConfig = (providerId: string): ProjectProviderConfig | undefined => {
    return settings.providers[providerId];
  };

  return {
    settings,
    isLoading,
    updateSettings,
    saveSettings,
    getProviderConfig,
  };
}
