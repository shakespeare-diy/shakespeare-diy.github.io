import { z } from "zod";
import { nip19 } from 'nostr-tools';

import type { Tool, ToolResult } from "./Tool";

type NostrEncodeType = 'npub' | 'note' | 'nprofile' | 'nevent' | 'naddr';

interface NostrEncodeParams {
  type: NostrEncodeType;
  hex: string;
  relays?: string[];
  author?: string;
  kind?: number;
  identifier?: string;
}

const HEX_64_REGEX = /^[0-9a-f]{64}$/;

export class NostrEncodeTool implements Tool<NostrEncodeParams> {
  readonly description = "Encode hex values into NIP-19 bech32 entities (npub, note, nprofile, nevent, naddr)";

  readonly inputSchema = z.object({
    type: z.enum(['npub', 'note', 'nprofile', 'nevent', 'naddr'])
      .describe(
        'The NIP-19 entity type to encode: npub (public key), note (event id), nprofile (profile with relay hints), nevent (event with relay hints and author), naddr (addressable event coordinate)',
      ),
    hex: z.string()
      .describe(
        'The hex string to encode. For npub/nprofile this is a 64-char hex public key. For note/nevent this is a 64-char hex event id. For naddr this is not used directly (use identifier instead), but should be set to the author pubkey.',
      ),
    relays: z.array(z.string())
      .optional()
      .describe(
        'Optional relay URL hints to attach. Used with nprofile, nevent, and naddr types.',
      ),
    author: z.string()
      .optional()
      .describe(
        'Optional author pubkey (64-char hex) to attach as a hint. Used with nevent type.',
      ),
    kind: z.number()
      .optional()
      .describe(
        'Event kind number. Required for naddr type.',
      ),
    identifier: z.string()
      .optional()
      .describe(
        'The "d" tag identifier for addressable events. Required for naddr type.',
      ),
  }).superRefine((data, ctx) => {
    // Validate hex for types that need it
    if (['npub', 'note', 'nprofile', 'nevent'].includes(data.type)) {
      if (!HEX_64_REGEX.test(data.hex)) {
        ctx.addIssue({
          code: 'custom',
          path: ['hex'],
          message: 'hex must be a 64-character lowercase hex string',
        });
      }
    }

    // Validate author hex if provided
    if (data.author && !HEX_64_REGEX.test(data.author)) {
      ctx.addIssue({
        code: 'custom',
        path: ['author'],
        message: 'author must be a 64-character lowercase hex public key',
      });
    }

    // Validate naddr-specific requirements
    if (data.type === 'naddr') {
      if (!HEX_64_REGEX.test(data.hex)) {
        ctx.addIssue({
          code: 'custom',
          path: ['hex'],
          message: 'For naddr, hex must be the 64-character lowercase hex author pubkey',
        });
      }
      if (data.kind === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'kind is required for naddr encoding',
        });
      }
      if (data.identifier === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['identifier'],
          message: 'identifier (d tag) is required for naddr encoding',
        });
      }
    }
  });

  async execute(args: NostrEncodeParams): Promise<ToolResult> {
    const { type, hex, relays, author, kind, identifier } = args;

    try {
      let encoded: string;

      switch (type) {
        case 'npub': {
          encoded = nip19.npubEncode(hex);
          break;
        }
        case 'note': {
          encoded = nip19.noteEncode(hex);
          break;
        }
        case 'nprofile': {
          encoded = nip19.nprofileEncode({
            pubkey: hex,
            relays: relays || [],
          });
          break;
        }
        case 'nevent': {
          encoded = nip19.neventEncode({
            id: hex,
            relays: relays || [],
            author: author,
          });
          break;
        }
        case 'naddr': {
          encoded = nip19.naddrEncode({
            pubkey: hex,
            kind: kind!,
            identifier: identifier || '',
            relays: relays || [],
          });
          break;
        }
        default:
          throw new Error(`Unsupported encode type: ${type}`);
      }

      return { content: encoded };
    } catch (error) {
      throw new Error(`Error encoding to ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
