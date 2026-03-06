import { join } from "path-browserify";
import { z } from "zod";
import mime from 'mime';
import { BlossomUploader } from '@nostrify/nostrify/uploaders';
import type { NostrSigner } from '@nostrify/nostrify';

import type { Tool, ToolResult } from "./Tool";
import type { JSRuntimeFS } from "../JSRuntime";

interface BlossomUploadParams {
  filePath: string;
}

export class BlossomUploadTool implements Tool<BlossomUploadParams> {
  readonly description = "Upload a file from the project to Blossom (a media hosting service). Returns the public URL and file metadata. Useful for hosting images, assets, or any file that needs a public URL.";

  readonly inputSchema = z.object({
    filePath: z.string()
      .describe('Path to the file to upload. Can be absolute or relative to the project directory.'),
  });

  constructor(
    private fs: JSRuntimeFS,
    private cwd: string,
    private signer?: NostrSigner,
  ) {}

  async execute(args: BlossomUploadParams): Promise<ToolResult> {
    if (!this.signer) {
      throw new Error('User must be logged in to upload files to Blossom.');
    }

    let filePath = args.filePath;

    // Handle relative paths
    if (!filePath.startsWith('/')) {
      filePath = join(this.cwd, filePath);
    }

    const content = await this.fs.readFile(filePath);
    const fileName = filePath.split('/').pop() || 'file';

    const file = new File([content], fileName, {
      type: mime.getType(filePath) || undefined,
    });

    const uploader = new BlossomUploader({
      servers: ['https://blossom.primal.net/'],
      signer: this.signer,
    });

    const tags = await uploader.upload(file);
    const url = tags.find(([name]) => name === 'url')?.[1];

    return {
      content: JSON.stringify({ url, tags }, null, 2),
    };
  }
}
