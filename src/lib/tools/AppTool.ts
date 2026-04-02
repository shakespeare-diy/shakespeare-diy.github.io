import { z } from 'zod';
import { NPool, NRelay1 } from '@nostrify/nostrify';
import type { NostrSigner } from '@nostrify/nostrify';

import { DotAI } from '../DotAI';
import { buildAppEvent } from '../appEvent';
import type { Tool, ToolResult } from './Tool';
import type { JSRuntimeFS } from '../JSRuntime';

interface AppToolParams {
  action: 'view_app' | 'update_app';
  name?: string;
  about?: string;
  picture?: string;
  website?: string;
  d?: string;
  supported_kinds?: string[];
  web_handlers?: Array<{ url: string; type?: string }>;
}

/**
 * AI tool for viewing and updating the project's NIP-89 kind 31990 app event.
 *
 * The agent must call `view_app` at least once in a session before calling `update_app`.
 * This ensures the agent is aware of the current state before making changes.
 */
export class AppTool implements Tool<AppToolParams> {
  private hasViewed = false;

  readonly description =
    'View or update the project\'s Nostr app (NIP-89 kind 31990). ' +
    'Use "view_app" to see the current app event. ' +
    'Use "update_app" to create or update the app event (you MUST call view_app first in this session before updating). ' +
    'This publishes the event using the user\'s own Nostr signer.';

  readonly inputSchema = z.object({
    action: z.enum(['view_app', 'update_app']).describe('The action to perform.'),
    name: z.string().optional().describe('App name (required for update_app if creating new).'),
    about: z.string().optional().describe('Short description of the app.'),
    picture: z.string().optional().describe('URL to the app icon.'),
    website: z.string().optional().describe('App website URL.'),
    d: z.string().optional().describe('Unique identifier (d-tag) for the app. Defaults to the project ID. Cannot be changed after first publish.'),
    supported_kinds: z.array(z.string()).optional().describe('Array of event kind numbers this app handles.'),
    web_handlers: z.array(z.object({
      url: z.string().describe('Handler URL pattern with <bech32> placeholder.'),
      type: z.string().optional().describe('NIP-19 type handled by this URL (e.g. "nevent", "nprofile").'),
    })).optional().describe('Web handler URL patterns.'),
  });

  constructor(
    private fs: JSRuntimeFS,
    private cwd: string,
    private signer: NostrSigner | undefined,
    private pubkey: string | undefined,
    private relayUrls: string[],
  ) {}

  async execute(args: AppToolParams): Promise<ToolResult> {
    switch (args.action) {
      case 'view_app':
        return this.viewApp();
      case 'update_app':
        return this.updateApp(args);
      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  }

  private async viewApp(): Promise<ToolResult> {
    const dotAI = new DotAI(this.fs, this.cwd);
    const config = await dotAI.readAppConfig();

    if (!config) {
      this.hasViewed = true;
      return {
        content: JSON.stringify({
          status: 'no_app',
          message: 'No app has been published for this project yet. Use update_app to create one.',
        }, null, 2),
      };
    }

    // Parse the "a" coordinate
    const parts = config.a.split(':');
    if (parts.length < 3) {
      this.hasViewed = true;
      return {
        content: JSON.stringify({
          status: 'error',
          message: `Invalid app coordinate stored: ${config.a}`,
        }, null, 2),
      };
    }

    const kind = parseInt(parts[0], 10);
    const pubkey = parts[1];
    const dTag = parts.slice(2).join(':');

    // Query relays for the event
    const pool = this.createPool();

    try {
      const events = await pool.query(
        [{
          kinds: [kind],
          authors: [pubkey],
          '#d': [dTag],
          limit: 1,
        }],
        { signal: AbortSignal.timeout(5000) },
      );

      this.hasViewed = true;

      if (events.length === 0) {
        return {
          content: JSON.stringify({
            status: 'not_found',
            a: config.a,
            message: 'App coordinate is stored locally but the event was not found on relays. It may have been deleted or the relays are unavailable. Use update_app to republish.',
          }, null, 2),
        };
      }

      const event = events.reduce((latest, current) =>
        current.created_at > latest.created_at ? current : latest,
      );

      // Parse content metadata
      let metadata: Record<string, string> = {};
      try {
        if (event.content) {
          metadata = JSON.parse(event.content);
        }
      } catch {
        // Invalid JSON content
      }

      const supportedKinds = event.tags
        .filter(([t]) => t === 'k')
        .map(([, v]) => v);

      const webHandlers = event.tags
        .filter(([t]) => t === 'web')
        .map(([, url, type]) => ({ url, type }));

      return {
        content: JSON.stringify({
          status: 'found',
          a: config.a,
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          metadata: {
            name: metadata.name ?? null,
            about: metadata.about ?? null,
            picture: metadata.picture ?? null,
            website: metadata.website ?? null,
          },
          d_tag: dTag,
          supported_kinds: supportedKinds,
          web_handlers: webHandlers,
          all_tags: event.tags,
        }, null, 2),
      };
    } finally {
      await pool.close();
    }
  }

  private async updateApp(args: AppToolParams): Promise<ToolResult> {
    if (!this.hasViewed) {
      throw new Error(
        'You must call view_app first before updating the app. ' +
        'This ensures you are aware of the current state of the app before making changes.',
      );
    }

    if (!this.signer) {
      throw new Error('User must be logged in with Nostr to publish an app event.');
    }

    if (!this.pubkey) {
      throw new Error('User pubkey is not available.');
    }

    // Check if an existing app is stored
    const dotAI = new DotAI(this.fs, this.cwd);
    const existingConfig = await dotAI.readAppConfig();

    // Determine the d-tag
    let dTag: string;
    if (existingConfig) {
      // Use existing d-tag (cannot be changed)
      const parts = existingConfig.a.split(':');
      dTag = parts.slice(2).join(':');
    } else {
      // Use provided d-tag or derive from project path
      dTag = args.d?.trim() || this.cwd.split('/').pop() || crypto.randomUUID();
    }

    if (!args.name?.trim()) {
      throw new Error('App name is required. Provide a "name" parameter.');
    }

    // Build event content and tags
    const { content, tags } = await buildAppEvent(
      {
        name: args.name,
        about: args.about,
        picture: args.picture,
        website: args.website,
        dTag,
        supportedKinds: args.supported_kinds,
        webHandlers: args.web_handlers,
      },
      { fs: this.fs, cwd: this.cwd, pubkey: this.pubkey },
    );

    // Add client tag
    if (typeof location !== 'undefined' && location.protocol === 'https:') {
      tags.push(['client', location.hostname]);
    }

    // Sign the event
    const event = await this.signer.signEvent({
      kind: 31990,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });

    // Publish to relays
    const pool = this.createPool();

    try {
      await pool.event(event, { signal: AbortSignal.timeout(10_000) });

      // Store the "a" coordinate
      const aValue = `31990:${event.pubkey}:${dTag}`;
      await dotAI.writeAppConfig({ a: aValue });

      return {
        content: JSON.stringify({
          status: 'published',
          a: aValue,
          id: event.id,
          pubkey: event.pubkey,
          name: args.name!.trim(),
          message: existingConfig
            ? `App "${args.name!.trim()}" has been updated on Nostr.`
            : `App "${args.name!.trim()}" has been published to Nostr.`,
        }, null, 2),
      };
    } finally {
      await pool.close();
    }
  }

  private createPool(): NPool {
    const relayUrls = this.relayUrls;
    return new NPool({
      open(url) {
        return new NRelay1(url);
      },
      eventRouter() {
        return [...relayUrls];
      },
      reqRouter(filters) {
        return new Map(
          relayUrls.map((url) => [url, filters]),
        );
      },
    });
  }
}
