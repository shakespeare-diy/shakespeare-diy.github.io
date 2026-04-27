import { join } from "path-browserify";
import type { JSRuntimeFS, DirectoryEntry } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'ls' command.
 *
 * Supported options:
 *   -a        Include entries starting with '.'
 *   -A        Like -a, but exclude '.' and '..' (we never emit those anyway)
 *   -l        Long format
 *   -1        One entry per line
 *   -R        Recurse into subdirectories
 *   -d        List directories themselves, not their contents
 *   -F        Append indicator (/ for dir, * for exec, @ for symlink) - simplified
 *   -h        Human-readable sizes (with -l)
 *   -r        Reverse sort order
 *   -t        Sort by modification time (newest first)
 *   -S        Sort by size (largest first)
 *   -n        Like -l but numeric uid/gid
 *   --        End of options
 */
export class LsCommand implements ShellCommand {
  name = 'ls';
  description = 'List directory contents';
  usage = 'ls [-aAldrRt1FhSn] [--] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['a', 'A', 'l', '1', 'R', 'd', 'F', 'h', 'r', 't', 'S', 'n'],
      booleanLong: ['all', 'almost-all', 'recursive', 'human-readable', 'reverse'],
      longToShort: {
        all: 'a',
        'almost-all': 'A',
        recursive: 'R',
        'human-readable': 'h',
        reverse: 'r',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      all: parsed.flags.has('a'),
      almostAll: parsed.flags.has('A'),
      long: parsed.flags.has('l') || parsed.flags.has('n'),
      onePerLine: parsed.flags.has('1'),
      recursive: parsed.flags.has('R'),
      dirAsFile: parsed.flags.has('d'),
      classify: parsed.flags.has('F'),
      human: parsed.flags.has('h'),
      reverse: parsed.flags.has('r'),
      sortTime: parsed.flags.has('t'),
      sortSize: parsed.flags.has('S'),
    };

    const targetPaths = parsed.operands.length > 0 ? parsed.operands : ['.'];

    // First pass: separate file operands from directory operands.
    const filesEntries: Array<{ name: string; path: string; stats: Stats }> = [];
    const dirEntries: Array<{ displayPath: string; absPath: string }> = [];

    for (const p of targetPaths) {
      const absPath = resolvePath(p, cwd);
      try {
        const stats = await this.fs.stat(absPath);
        if (stats.isDirectory() && !opts.dirAsFile) {
          dirEntries.push({ displayPath: p, absPath });
        } else {
          filesEntries.push({ name: p, path: absPath, stats });
        }
      } catch (error) {
        const { kind } = classifyFsError(error);
        if (kind === 'ENOENT') {
          return createErrorResult(`${this.name}: cannot access '${p}': No such file or directory`);
        }
        if (kind === 'EACCES') {
          return createErrorResult(`${this.name}: cannot access '${p}': Permission denied`);
        }
        return createErrorResult(`${this.name}: cannot access '${p}': ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const outputs: string[] = [];

    // Files first, per POSIX.
    if (filesEntries.length > 0) {
      const items: LsItem[] = filesEntries.map((e) => ({
        name: e.name,
        stats: e.stats,
        isDir: e.stats.isDirectory(),
      }));
      this.sortItems(items, opts);
      outputs.push(this.formatItems(items, opts));
    }

    // Directories.
    const showHeader = dirEntries.length + filesEntries.length > 1 || opts.recursive;

    for (let idx = 0; idx < dirEntries.length; idx++) {
      const { displayPath, absPath } = dirEntries[idx];
      if (idx > 0 || filesEntries.length > 0) outputs.push('');

      await this.listDir(absPath, displayPath, opts, outputs, showHeader);
    }

    let out = outputs.filter((s) => s.length > 0 || outputs.length > 1).join('\n');
    if (out.length > 0 && !out.endsWith('\n')) out += '\n';
    return createSuccessResult(out);
  }

  private async listDir(
    absPath: string,
    displayPath: string,
    opts: LsOptions,
    outputs: string[],
    showHeader: boolean
  ): Promise<void> {
    let entries: DirectoryEntry[];
    try {
      entries = await this.fs.readdir(absPath, { withFileTypes: true });
    } catch (error) {
      const { kind } = classifyFsError(error);
      const msg =
        kind === 'EACCES'
          ? `${this.name}: cannot open directory '${displayPath}': Permission denied`
          : `${this.name}: cannot open directory '${displayPath}': ${error instanceof Error ? error.message : 'Unknown error'}`;
      outputs.push(msg);
      return;
    }

    // Filter hidden files according to -a / -A
    let filtered = entries;
    if (!opts.all && !opts.almostAll) {
      filtered = entries.filter((e) => !e.name.startsWith('.'));
    }

    // Gather stats per entry.
    const items: LsItem[] = [];
    for (const entry of filtered) {
      const entryPath = join(absPath, entry.name);
      let stats: Stats | undefined;
      try {
        stats = await this.fs.stat(entryPath);
      } catch {
        // If stat fails, still show the entry with unknown stats.
      }
      items.push({
        name: entry.name,
        stats,
        isDir: entry.isDirectory(),
      });
    }

    this.sortItems(items, opts);

    if (showHeader) {
      outputs.push(`${displayPath}:`);
    }
    outputs.push(this.formatItems(items, opts));

    if (opts.recursive) {
      for (const item of items) {
        if (item.isDir) {
          const subAbs = join(absPath, item.name);
          const subDisplay = displayPath.endsWith('/') ? displayPath + item.name : `${displayPath}/${item.name}`;
          outputs.push('');
          await this.listDir(subAbs, subDisplay, opts, outputs, true);
        }
      }
    }
  }

  private sortItems(items: LsItem[], opts: LsOptions): void {
    items.sort((a, b) => {
      if (opts.sortTime) {
        const at = a.stats?.mtimeMs ?? 0;
        const bt = b.stats?.mtimeMs ?? 0;
        if (at !== bt) return bt - at;
      } else if (opts.sortSize) {
        const as = a.stats?.size ?? 0;
        const bs = b.stats?.size ?? 0;
        if (as !== bs) return bs - as;
      }
      return a.name.localeCompare(b.name);
    });
    if (opts.reverse) items.reverse();
  }

  private formatItems(items: LsItem[], opts: LsOptions): string {
    if (items.length === 0) return '';

    if (opts.long) {
      return items.map((i) => this.formatLong(i, opts)).join('\n');
    }

    const names = items.map((i) => this.decorate(i, opts));

    if (opts.onePerLine) {
      return names.join('\n');
    }
    // Simple column-free listing (two-space separated is a common default).
    return names.join('  ');
  }

  private formatLong(item: LsItem, opts: LsOptions): string {
    const size = item.stats?.size ?? 0;
    const sizeStr = opts.human ? humanSize(size) : String(size);
    const mtime = item.stats?.mtimeMs
      ? new Date(item.stats.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
      : 'unknown         ';
    const perm = item.isDir ? 'drwxr-xr-x' : '-rw-r--r--';
    const name = this.decorate(item, opts);
    return `${perm} 1 user user ${sizeStr.padStart(8)} ${mtime} ${name}`;
  }

  private decorate(item: LsItem, opts: LsOptions): string {
    // By project convention, always append '/' to directory names in short
    // format (and honor -F elsewhere); in long format, keep the name plain.
    if (item.isDir && !opts.long) return item.name + '/';
    if (opts.classify && item.isDir) return item.name + '/';
    return item.name;
  }
}

interface Stats {
  isDirectory(): boolean;
  isFile(): boolean;
  size?: number;
  mtimeMs?: number;
}

interface LsItem {
  name: string;
  stats?: Stats;
  isDir: boolean;
}

interface LsOptions {
  all: boolean;
  almostAll: boolean;
  long: boolean;
  onePerLine: boolean;
  recursive: boolean;
  dirAsFile: boolean;
  classify: boolean;
  human: boolean;
  reverse: boolean;
  sortTime: boolean;
  sortSize: boolean;
}

function humanSize(n: number): string {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${n}${units[0]}`;
  const s = v >= 10 ? v.toFixed(0) : v.toFixed(1);
  return `${s}${units[i]}`;
}
