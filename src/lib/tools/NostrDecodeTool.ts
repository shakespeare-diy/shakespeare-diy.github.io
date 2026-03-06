import { z } from "zod";
import { nip19 } from 'nostr-tools';

import type { Tool, ToolResult } from "./Tool";

interface NostrDecodeParams {
  value: string;
}

export class NostrDecodeTool implements Tool<NostrDecodeParams> {
  readonly description = "Decode NIP-19 bech32 entities (npub, note, nprofile, nevent, naddr, nsec) into their hex and structured data representations";

  readonly inputSchema = z.object({
    value: z.string()
      .superRefine((val, ctx) => {
        // Strip nostr: URI prefix if present (NIP-21)
        const cleaned = val.startsWith('nostr:') ? val.slice(6) : val;

        try {
          nip19.decode(cleaned);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid NIP-19 identifier: ${val}. Expected an npub, note, nprofile, nevent, naddr, or nsec string.`,
          });
        }
      })
      .describe(
        'A NIP-19 bech32-encoded identifier to decode (npub1..., note1..., nprofile1..., nevent1..., naddr1...). Also accepts nostr: URI prefix (NIP-21).',
      ),
  });

  async execute(args: NostrDecodeParams): Promise<ToolResult> {
    const { value } = args;

    // Strip nostr: URI prefix if present (NIP-21)
    const cleaned = value.startsWith('nostr:') ? value.slice(6) : value;

    try {
      const decoded = nip19.decode(cleaned);

      // Reject nsec for security reasons
      if (decoded.type === 'nsec') {
        throw new Error('nsec identifiers should not be shared or decoded in this context for security reasons');
      }

      return { content: JSON.stringify(decoded, null, 2) };
    } catch (error) {
      throw new Error(`Error decoding NIP-19 value: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
