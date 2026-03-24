/**
 * Utilities for reading and writing the `.nsite/config.json` file in a project's VFS directory.
 *
 * NOTE: The site private key (nsec) is NEVER stored here. It lives only in
 * `.git/shakespeare/deploy.json` (never committed). This file is safe to commit to git.
 */

import { z } from 'zod';
import type { JSRuntimeFS } from './JSRuntime';

/** Path of the nsite config directory relative to a project root */
const NSITE_CONFIG_DIR = '.nsite';

/** Path of the nsite config file relative to a project root */
const NSITE_CONFIG_FILE = '.nsite/config.json';

/**
 * Configuration for an nsite deployment, stored in `.nsite/config.json`.
 * Unknown keys in an existing file are preserved on read and write.
 */
export interface NsiteVfsConfig {
  /** Nostr relay WebSocket URLs (`wss://`) */
  relays: string[];
  /** Blossom server HTTPS URLs (`https://`) */
  servers: string[];
  /**
   * Named-site d-tag identifier (kind 35128).
   * `null` or absent → root site (kind 15128).
   * Non-empty string → named site.
   */
  id?: string | null;
  /** Optional site title included in the manifest event */
  title?: string;
  /** Optional site description included in the manifest event */
  description?: string;
  /**
   * HTML file served as the 404 fallback for client-side routing.
   * Always `/index.html` for Shakespeare SPA projects.
   */
  fallback?: string;
  /** Gateway hostnames that serve this nsite */
  gatewayHostnames?: string[];
}

const nsiteVfsConfigSchema = z
  .object({
    relays: z.array(z.string()),
    servers: z.array(z.string()),
    id: z.string().nullable().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    fallback: z.string().optional(),
    gatewayHostnames: z.array(z.string()).optional(),
  })
  .passthrough(); // preserve unknown keys in existing files

/**
 * Read `.nsite/config.json` from the VFS for the given project path.
 *
 * Returns `null` if the file does not exist or cannot be parsed.
 */
export async function readNsiteVfsConfig(
  fs: JSRuntimeFS,
  projectPath: string,
): Promise<NsiteVfsConfig | null> {
  const filePath = `${projectPath}/${NSITE_CONFIG_FILE}`;

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw as string);
    const validated = nsiteVfsConfigSchema.parse(parsed);
    return validated as NsiteVfsConfig;
  } catch (err) {
    if (err instanceof Error && err.message.includes('ENOENT')) {
      // File doesn't exist yet — not an error
      return null;
    }
    console.warn('[nsiteConfig] Failed to read .nsite/config.json:', err);
    return null;
  }
}

/**
 * Write `.nsite/config.json` to the VFS for the given project path.
 *
 * Merges with any existing file content so that unknown keys are not lost.
 * Creates the `.nsite/` directory if it does not exist.
 */
export async function writeNsiteVfsConfig(
  fs: JSRuntimeFS,
  projectPath: string,
  config: NsiteVfsConfig,
): Promise<void> {
  const dirPath = `${projectPath}/${NSITE_CONFIG_DIR}`;
  const filePath = `${projectPath}/${NSITE_CONFIG_FILE}`;

  // Read existing file to preserve unknown keys
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    existing = JSON.parse(raw as string);
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Merge: known fields overwrite, unknown keys are preserved
  const merged: Record<string, unknown> = { ...existing, ...config };

  // Remove undefined values so the JSON stays clean
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }

  // Ensure .nsite/ directory exists
  try {
    await fs.stat(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }

  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
}
