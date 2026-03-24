import type { NostrSigner, NPool } from '@nostrify/nostrify';
import mime from 'mime';
import { nip19 } from 'nostr-tools';
import type { JSRuntimeFS } from '../JSRuntime';
import type { DeployAdapter, DeployOptions, DeployResult, NsiteDeployConfig } from './types';
import { buildNsiteUrl } from '../utils/nsite';

/** nsite v2 root-site kind (replaceable by pubkey+kind) */
const NSITE_ROOT_SITE_KIND = 15128;

/** nsite v2 named-site kind (addressable by pubkey+kind+d) */
const NSITE_NAMED_SITE_KIND = 35128;

/** BUD-02 Blossom authorization event kind */
const BLOSSOM_AUTH_KIND = 24242;

/** Max number of sha256 hashes covered by one batch auth event */
const UPLOAD_AUTH_BATCH_SIZE = 20;

/** Max concurrent uploads per Blossom server */
const UPLOAD_CONCURRENCY = 4;

/** Timeout for individual HTTP requests (ms) */
const FETCH_TIMEOUT_MS = 15_000;

interface FileEntry {
  /** Absolute path in the manifest, e.g. "/index.html" */
  path: string;
  /** Raw file bytes as a concrete ArrayBuffer (for Web Crypto + File constructor compatibility) */
  data: ArrayBuffer;
  /** Lower-case hex SHA-256 of data */
  sha256: string;
  /** MIME type */
  contentType: string;
}

/**
 * Encode an ArrayBuffer / Uint8Array as a lower-case hex string.
 */
function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the SHA-256 of a Uint8Array and return the hex digest.
 * The Uint8Array must already be backed by a concrete ArrayBuffer
 * (use raw.slice() before calling this to ensure no SharedArrayBuffer).
 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
  return encodeHex(new Uint8Array(buf));
}

/**
 * Build a BUD-02 kind-24242 upload-auth event template covering multiple blobs.
 * The signed event is base64-encoded and returned as the full Authorization header value.
 */
async function createBatchUploadAuth(
  signer: NostrSigner,
  sha256Hashes: string[],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const template = {
    kind: BLOSSOM_AUTH_KIND,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ...sha256Hashes.map(h => ['x', h]),
      ['expiration', String(now + 3600)],
    ],
    content: 'Upload blobs',
  };
  const signed = await signer.signEvent(template);
  return `Nostr ${btoa(JSON.stringify(signed))}`;
}

/**
 * Check whether a blob already exists on a Blossom server.
 * Returns true if the server responds 2xx to a HEAD request.
 */
async function blobExistsOnServer(serverBase: string, sha256: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(`${serverBase}/${sha256}`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Upload a single file to a single Blossom server using a pre-signed auth header.
 * Skips the upload if the blob already exists on the server.
 * Returns true on success or if already present.
 */
async function uploadToServer(
  serverBase: string,
  file: FileEntry,
  authHeader: string,
): Promise<boolean> {
  // Skip if already present
  if (await blobExistsOnServer(serverBase, file.sha256)) {
    return true;
  }

  const blob = new File([file.data], file.path.split('/').pop() || 'file', {
    type: file.contentType,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(`${serverBase}/upload`, {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': file.contentType,
        },
        body: blob,
        signal: controller.signal,
      });
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Run an async task queue with a fixed concurrency limit.
 */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * Nsite Deploy Adapter — v2 implementation
 *
 * Deploys a built project as a Nostr static site using the nsite v2 spec:
 * - Uses the logged-in user's NostrSigner — no dedicated per-site keypair needed
 * - Pre-hashes all files with SHA-256 (Web Crypto API)
 * - Signs batched BUD-02 kind-24242 auth tokens (20 files per signing call)
 * - HEAD-checks each file on each Blossom server before uploading
 * - PUTs files to Blossom servers with pre-signed auth headers
 * - Publishes a single kind-15128 (root) or kind-35128 (named) site manifest event
 *   containing all ["path", "/path", sha256] tags, ["server", url] Blossom hints,
 *   and ["relay", url] relay hints — no separate kind 10002 or kind 10063 published
 *
 * Named sites (kind 35128, siteIdentifier set):
 *   URL = https://{base36pubkey}{siteIdentifier}.{gateway}
 * Root sites (kind 15128, no siteIdentifier):
 *   URL = https://{npub}.{gateway}
 */
export class NsiteAdapter implements DeployAdapter {
  private fs: JSRuntimeFS;
  private nostr: NsiteDeployConfig['nostr'];
  private signer: NostrSigner;
  private gateway: string;
  private relayUrls: string[];
  private blossomServers: string[];
  private siteTitle?: string;
  private siteDescription?: string;
  private siteIdentifier?: string;

  constructor(config: NsiteDeployConfig) {
    this.fs = config.fs;
    this.nostr = config.nostr;
    this.signer = config.signer;
    this.gateway = config.gateway;
    this.relayUrls = config.relayUrls;
    this.blossomServers = config.blossomServers;
    this.siteTitle = config.siteTitle;
    this.siteDescription = config.siteDescription;
    this.siteIdentifier = config.siteIdentifier;
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const { projectPath } = options;
    const distPath = `${projectPath}/dist`;

    // Verify build output exists
    try {
      await this.fs.readFile(`${distPath}/index.html`, 'utf8');
    } catch {
      throw new Error('No index.html found in dist directory. Please build the project first.');
    }

    const pubkey = await this.signer.getPublicKey();
    const npub = nip19.npubEncode(pubkey);

    // Create grouped relay client
    const relayClient = this.nostr.group(this.relayUrls);

    // ── Step 1: Walk dist/ and read + hash all files ──────────────────────────
    const files: FileEntry[] = [];
    await this.collectFiles(distPath, '', files);

    if (files.length === 0) {
      throw new Error('No files found in dist directory.');
    }

    // ── Step 2: Pre-sign batched BUD-02 auth tokens ───────────────────────────
    // One kind-24242 event covers up to UPLOAD_AUTH_BATCH_SIZE sha256 hashes,
    // dramatically reducing signer calls when using remote signers/bunkers.
    const authTokenMap = new Map<string, string>();
    for (let i = 0; i < files.length; i += UPLOAD_AUTH_BATCH_SIZE) {
      const batch = files.slice(i, i + UPLOAD_AUTH_BATCH_SIZE);
      const hashes = batch.map(f => f.sha256);
      const authHeader = await createBatchUploadAuth(this.signer, hashes);
      for (const hash of hashes) {
        authTokenMap.set(hash, authHeader);
      }
    }

    // ── Step 3: Upload files to each Blossom server ───────────────────────────
    // All servers upload concurrently; within each server, files are uploaded
    // with limited concurrency to avoid overwhelming the server.
    // Track which files land on at least one server — a file missing from every
    // server means the manifest would point to an unreachable blob.
    const serverBases = this.blossomServers.map(s => s.replace(/\/$/, ''));

    // uploadedSha256s: set of sha256 hashes confirmed present on ≥1 server
    const uploadedSha256s = new Set<string>();

    await Promise.all(
      serverBases.map(serverBase =>
        runConcurrent(files, UPLOAD_CONCURRENCY, async (file) => {
          const authHeader = authTokenMap.get(file.sha256);
          if (!authHeader) return;
          const ok = await uploadToServer(serverBase, file, authHeader);
          if (ok) {
            uploadedSha256s.add(file.sha256);
          }
        }),
      ),
    );

    // Fail fast: any file unreachable on all servers means the deployed site
    // would serve broken responses for those paths — abort before publishing.
    const failedFiles = files.filter(f => !uploadedSha256s.has(f.sha256));
    if (failedFiles.length > 0) {
      const paths = failedFiles.map(f => f.path).join(', ');
      throw new Error(
        `Failed to upload ${failedFiles.length} file(s) to any Blossom server: ${paths}`,
      );
    }

    // ── Step 4: Build the site manifest event ────────────────────────────────
    // kind 35128 for named sites (has siteIdentifier / d tag)
    // kind 15128 for root site (no d tag)
    const isNamedSite = Boolean(this.siteIdentifier);
    const manifestKind = isNamedSite ? NSITE_NAMED_SITE_KIND : NSITE_ROOT_SITE_KIND;

    const pathTags: string[][] = files.map(f => ['path', f.path, f.sha256]);

    // SPA fallback: map /404.html to the same blob as /index.html so that
    // React Router (and other SPAs) work correctly — the nsite host server
    // serves /404.html when a path is not found, acting as a client-side router fallback.
    const indexFile = files.find(f => f.path === '/index.html');
    if (indexFile && !files.some(f => f.path === '/404.html')) {
      pathTags.push(['path', '/404.html', indexFile.sha256]);
    }

    const serverTags: string[][] = serverBases.map(url => ['server', url]);
    const relayTags: string[][] = this.relayUrls.map(url => ['relay', url]);

    const tags: string[][] = [];

    // d tag must come first for addressable events (kind 35128)
    if (isNamedSite && this.siteIdentifier) {
      tags.push(['d', this.siteIdentifier]);
    }

    tags.push(...pathTags, ...serverTags, ...relayTags);

    if (this.siteTitle) {
      tags.push(['title', this.siteTitle]);
    }

    if (this.siteDescription) {
      tags.push(['description', this.siteDescription]);
    }

    const manifestEvent = await this.signer.signEvent({
      kind: manifestKind,
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      tags,
    });

    // ── Step 5: Publish manifest ──────────────────────────────────────────────
    // Relay and server hints are embedded as tags in the manifest itself —
    // no separate kind 10002 or kind 10063 events are published.
    await relayClient.event(manifestEvent, { signal: AbortSignal.timeout(10_000) });

    // Build the deployed URL
    const siteUrl = buildNsiteUrl({
      pubkeyHex: pubkey,
      npub,
      gateway: this.gateway,
      siteIdentifier: this.siteIdentifier,
    });

    return {
      url: siteUrl,
      metadata: {
        pubkey,
        npub,
        filesPublished: files.length,
        provider: 'nsite',
        siteIdentifier: this.siteIdentifier,
        manifestKind,
      },
    };
  }

  /**
   * Recursively walk a directory in the VFS, reading every file and computing its SHA-256.
   * Populates the provided `files` array with fully resolved FileEntry objects.
   */
  private async collectFiles(
    dirPath: string,
    relativePrefix: string,
    files: FileEntry[],
  ): Promise<void> {
    const entries = await this.fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.collectFiles(fullPath, relPath, files);
      } else if (entry.isFile()) {
        const raw = await this.fs.readFile(fullPath) as Uint8Array;
        // raw.slice() copies bytes into a new Uint8Array backed by a concrete ArrayBuffer,
        // avoiding the SharedArrayBuffer variant that Web Crypto and File refuse.
        const sliced = raw.slice();
        const data: ArrayBuffer = sliced.buffer as ArrayBuffer;
        const sha256 = await sha256Hex(sliced);
        const absolutePath = `/${relPath}`;
        const contentType = mime.getType(fullPath) || 'application/octet-stream';

        files.push({ path: absolutePath, data, sha256, contentType });
      }
    }
  }
}
