import type { JSRuntimeFS, DirectoryEntry } from './JSRuntime';

/**
 * Electron filesystem adapter that implements JSRuntimeFS interface
 * This adapter communicates with Electron's main process via IPC to perform
 * filesystem operations on the actual OS filesystem.
 *
 * Note: This adapter should only be instantiated when running in Electron.
 */
export class ElectronFSAdapter implements JSRuntimeFS {
  // Cache for stat results to avoid repeated IPC calls
  private statCache = new Map<string, { result: Awaited<ReturnType<typeof this.electron.fs.stat>>; timestamp: number }>();
  private readonly STAT_CACHE_TTL = 1000; // 1 second TTL for stat cache

  // Cache for ENOENT results to avoid repeated failed reads (especially for git objects)
  private enoentCache = new Set<string>();
  private readonly ENOENT_CACHE_MAX_SIZE = 5000;

  private get electron() {
    if (!window.electron) {
      throw new Error('ElectronFSAdapter can only be used in Electron environment');
    }
    return window.electron;
  }

  /**
   * Unwrap Electron IPC errors to preserve error codes.
   * Electron wraps errors in "Error invoking remote method..." messages,
   * but we need to preserve the original error code for isomorphic-git.
   */
  private unwrapElectronError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return error as Error;
    }

    // Extract error code from the error object if it exists
    const code = (error as NodeJS.ErrnoException).code;

    // If there's already a code, preserve it
    if (code) {
      const err = new Error(error.message);
      (err as NodeJS.ErrnoException).code = code;
      return err;
    }

    // If no code property, try to extract from the message
    // Messages look like: "Error invoking remote method 'fs:stat': Error: Failed to stat /path: ENOENT: no such file or directory"
    const match = error.message.match(/:\s*(E[A-Z]+):/);
    if (match) {
      const err = new Error(error.message);
      (err as NodeJS.ErrnoException).code = match[1];
      return err;
    }

    return error;
  }

  async readFile(path: string): Promise<Uint8Array<ArrayBufferLike>>;
  async readFile(path: string, options: 'utf8'): Promise<string>;
  async readFile(path: string, options: string): Promise<string>;
  async readFile(path: string, options: { encoding: 'utf8' }): Promise<string>;
  async readFile(path: string, options: { encoding: string }): Promise<string>;
  async readFile(path: string, options?: string | { encoding?: string }): Promise<string | Uint8Array<ArrayBufferLike>>;
  async readFile(path: string, options?: string | { encoding?: string }): Promise<string | Uint8Array<ArrayBufferLike>> {
    try {
      // Validate path is not empty (isomorphic-git sometimes passes empty strings during ref resolution)
      if (!path || path.trim() === '') {
        const err = new Error(`EINVAL: invalid path ''`);
        (err as NodeJS.ErrnoException).code = 'EINVAL';
        throw err;
      }

      // Check if we've already seen ENOENT for this path (common for git packed objects)
      if (this.enoentCache.has(path)) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }

      const encoding = typeof options === 'string' ? options : options?.encoding;
      const result = await this.electron.fs.readFile(path, encoding);

      // If no encoding, convert array to Uint8Array
      if (!encoding && Array.isArray(result)) {
        return new Uint8Array(result);
      }

      return result as string;
    } catch (error) {
      const unwrapped = this.unwrapElectronError(error);

      // Cache ENOENT errors to avoid repeated IPC calls for missing files
      // This is especially important for git packed objects that isomorphic-git tries to read
      if ((unwrapped as NodeJS.ErrnoException).code === 'ENOENT') {
        this.enoentCache.add(path);

        // Limit cache size to prevent memory leaks
        if (this.enoentCache.size > this.ENOENT_CACHE_MAX_SIZE) {
          // Clear oldest entries (first 1000)
          const entries = Array.from(this.enoentCache);
          entries.slice(0, 1000).forEach(entry => this.enoentCache.delete(entry));
        }
      }

      throw unwrapped;
    }
  }

  async writeFile(path: string, data: string | Uint8Array<ArrayBufferLike>, options?: string | { encoding?: string }): Promise<void> {
    try {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      // Convert Uint8Array to regular array for IPC serialization
      const dataToWrite = data instanceof Uint8Array ? Array.from(data) : data;
      const result = await this.electron.fs.writeFile(path, dataToWrite, encoding);

      // Invalidate caches for this path and its parent directory
      this.statCache.delete(path);
      this.statCache.delete(`lstat:${path}`);
      this.enoentCache.delete(path); // File now exists
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      if (parentDir) {
        this.statCache.delete(parentDir);
        this.statCache.delete(`lstat:${parentDir}`);
      }

      return result;
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async readdir(path: string): Promise<string[]>;
  async readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirectoryEntry[]>;
  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirectoryEntry[]> {
    try {
      // Fast path: check if this is a file first (common case causing errors)
      // Use cached stat if available to avoid extra IPC call
      const cached = this.statCache.get(path);
      if (cached && Date.now() - cached.timestamp < this.STAT_CACHE_TTL) {
        if (cached.result.isFile) {
          // This is a file, not a directory - throw ENOTDIR immediately
          const err = new Error(`ENOTDIR: not a directory, scandir '${path}'`);
          (err as NodeJS.ErrnoException).code = 'ENOTDIR';
          throw err;
        }
      }

      const result = await this.electron.fs.readdir(path, options?.withFileTypes);

      if (options?.withFileTypes) {
        // Convert plain objects to DirectoryEntry format
        return (result as Array<{ name: string; isDirectory: boolean; isFile: boolean }>).map(entry => ({
          name: entry.name,
          isDirectory: () => entry.isDirectory,
          isFile: () => entry.isFile,
        }));
      }

      return result as string[];
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    try {
      // Default to recursive: true for isomorphic-git compatibility
      // isomorphic-git expects mkdir to behave like 'mkdir -p'
      const recursive = options?.recursive !== false;
      const result = await this.electron.fs.mkdir(path, recursive);

      // Invalidate cache for this path and parent
      this.statCache.delete(path);
      this.statCache.delete(`lstat:${path}`);
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      if (parentDir) {
        this.statCache.delete(parentDir);
        this.statCache.delete(`lstat:${parentDir}`);
      }

      return result;
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async stat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isSymbolicLink(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    atimeMs: number;
    mtime: Date;
    ctime: Date;
    atime: Date;
  }> {
    try {
      // Check cache first
      const cached = this.statCache.get(path);
      if (cached && Date.now() - cached.timestamp < this.STAT_CACHE_TTL) {
        return cached.result;
      }

      const result = await this.electron.fs.stat(path);
      const now = Date.now();
      const statResult = {
        isDirectory: () => result.isDirectory,
        isFile: () => result.isFile,
        isBlockDevice: () => result.isBlockDevice,
        isCharacterDevice: () => result.isCharacterDevice,
        isSymbolicLink: () => result.isSymbolicLink,
        isFIFO: () => result.isFIFO,
        isSocket: () => result.isSocket,
        size: result.size ?? 0,
        mtimeMs: result.mtimeMs ?? now,
        ctimeMs: result.ctimeMs ?? now,
        atimeMs: result.atimeMs ?? now,
        // Convert timestamps back to Date objects
        mtime: new Date(result.mtime ?? now),
        ctime: new Date(result.ctime ?? now),
        atime: new Date(result.atime ?? now),
      };

      // Cache the result
      this.statCache.set(path, { result: statResult, timestamp: Date.now() });

      // Limit cache size to prevent memory leaks
      if (this.statCache.size > 10000) {
        // Remove oldest entries (first 1000)
        const entries = Array.from(this.statCache.entries());
        entries.slice(0, 1000).forEach(([key]) => this.statCache.delete(key));
      }

      return statResult;
    } catch (error) {
      // Electron IPC wraps errors, extract the original error code
      throw this.unwrapElectronError(error);
    }
  }

  async lstat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isSymbolicLink(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    atimeMs: number;
    mtime: Date;
    ctime: Date;
    atime: Date;
  }> {
    try {
      // Check cache first (use separate cache key for lstat)
      const cacheKey = `lstat:${path}`;
      const cached = this.statCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.STAT_CACHE_TTL) {
        return cached.result;
      }

      const result = await this.electron.fs.lstat(path);
      const now = Date.now();
      const statResult = {
        isDirectory: () => result.isDirectory,
        isFile: () => result.isFile,
        isBlockDevice: () => result.isBlockDevice,
        isCharacterDevice: () => result.isCharacterDevice,
        isSymbolicLink: () => result.isSymbolicLink,
        isFIFO: () => result.isFIFO,
        isSocket: () => result.isSocket,
        size: result.size ?? 0,
        mtimeMs: result.mtimeMs ?? now,
        ctimeMs: result.ctimeMs ?? now,
        atimeMs: result.atimeMs ?? now,
        // Convert timestamps back to Date objects
        mtime: new Date(result.mtime ?? now),
        ctime: new Date(result.ctime ?? now),
        atime: new Date(result.atime ?? now),
      };

      // Cache the result
      this.statCache.set(cacheKey, { result: statResult, timestamp: Date.now() });

      // Limit cache size to prevent memory leaks
      if (this.statCache.size > 10000) {
        // Remove oldest entries (first 1000)
        const entries = Array.from(this.statCache.entries());
        entries.slice(0, 1000).forEach(([key]) => this.statCache.delete(key));
      }

      return statResult;
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async unlink(path: string): Promise<void> {
    try {
      const result = await this.electron.fs.unlink(path);

      // Invalidate cache for this path and parent
      this.statCache.delete(path);
      this.statCache.delete(`lstat:${path}`);
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      if (parentDir) {
        this.statCache.delete(parentDir);
        this.statCache.delete(`lstat:${parentDir}`);
      }

      return result;
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async rmdir(path: string): Promise<void> {
    try {
      const result = await this.electron.fs.rmdir(path);

      // Invalidate cache for this path and parent
      this.statCache.delete(path);
      this.statCache.delete(`lstat:${path}`);
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      if (parentDir) {
        this.statCache.delete(parentDir);
        this.statCache.delete(`lstat:${parentDir}`);
      }

      return result;
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    try {
      const result = await this.electron.fs.rename(oldPath, newPath);

      // Invalidate cache for both paths and their parents
      this.statCache.delete(oldPath);
      this.statCache.delete(`lstat:${oldPath}`);
      this.statCache.delete(newPath);
      this.statCache.delete(`lstat:${newPath}`);

      const oldParent = oldPath.substring(0, oldPath.lastIndexOf('/'));
      if (oldParent) {
        this.statCache.delete(oldParent);
        this.statCache.delete(`lstat:${oldParent}`);
      }

      const newParent = newPath.substring(0, newPath.lastIndexOf('/'));
      if (newParent) {
        this.statCache.delete(newParent);
        this.statCache.delete(`lstat:${newParent}`);
      }

      return result;
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async readlink(path: string): Promise<string> {
    try {
      return await this.electron.fs.readlink(path);
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  async symlink(target: string, path: string): Promise<void> {
    try {
      return await this.electron.fs.symlink(target, path);
    } catch (error) {
      throw this.unwrapElectronError(error);
    }
  }

  /**
   * Clear all caches. Useful when switching projects or after major filesystem changes.
   */
  clearCaches(): void {
    this.statCache.clear();
    this.enoentCache.clear();
  }
}
