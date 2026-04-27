import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

interface LogOptions {
  oneline: boolean;
  graph: boolean;
  format?: string;
  author?: string;
  grep?: string;
  since?: number;
  until?: number;
  patch: boolean;
  stat: boolean;
  nameOnly: boolean;
  nameStatus: boolean;
  follow?: string;
  noMerges: boolean;
  reverse: boolean;
}

interface CommitInfo {
  oid: string;
  commit: {
    message: string;
    author: { name: string; email: string; timestamp: number; timezoneOffset?: number };
    committer?: { name: string; email: string; timestamp: number; timezoneOffset?: number };
    parent?: string[];
  };
}

export class GitLogCommand implements GitSubcommand {
  name = 'log';
  description = 'Show commit logs';
  usage = 'git log [--oneline] [--graph] [--stat] [-p|--patch] [--name-only] [--name-status] [--author=<pattern>] [--grep=<pattern>] [--since=<date>] [--until=<date>] [--no-merges] [--reverse] [--format=<format>] [-n <number>] [--all] [<ref>]';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      // Check if we're in a git repository
      try {
        await this.fs.stat(`${cwd}/.git`);
      } catch {
        return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
      }

      const { options, limit, ref } = this.parseArgs(args);

      try {
        const logOptions: { dir: string; depth?: number; ref?: string } = { dir: cwd };
        if (limit !== undefined) {
          logOptions.depth = limit;
        }
        if (ref !== undefined) {
          logOptions.ref = ref;
        }

        let commits = await this.git.log(logOptions) as CommitInfo[];

        if (commits.length === 0) {
          return createErrorResult('fatal: your current branch does not have any commits yet');
        }

        // Apply filters
        commits = this.filterCommits(commits, options);

        if (options.reverse) {
          commits = [...commits].reverse();
        }

        // Determine format based on options
        const format = options.format || (options.oneline ? 'oneline' : 'full');

        return await this.formatLog(commits, format, options, cwd);

      } catch (error) {
        if (error instanceof Error && error.message.includes('does not exist')) {
          return createErrorResult('fatal: your current branch does not have any commits yet');
        }
        throw error;
      }

    } catch (error) {
      return createErrorResult(`git log: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private filterCommits(commits: CommitInfo[], options: LogOptions): CommitInfo[] {
    return commits.filter(commit => {
      if (options.author) {
        const authorStr = `${commit.commit.author.name} <${commit.commit.author.email}>`;
        if (!authorStr.toLowerCase().includes(options.author.toLowerCase())) return false;
      }
      if (options.grep) {
        if (!commit.commit.message.toLowerCase().includes(options.grep.toLowerCase())) return false;
      }
      if (options.since !== undefined && commit.commit.author.timestamp < options.since) return false;
      if (options.until !== undefined && commit.commit.author.timestamp > options.until) return false;
      if (options.noMerges && commit.commit.parent && commit.commit.parent.length > 1) return false;
      return true;
    });
  }

  private parseArgs(args: string[]): {
    options: LogOptions;
    limit: number | undefined;
    ref?: string;
  } {
    const options: LogOptions = {
      oneline: false,
      graph: false,
      patch: false,
      stat: false,
      nameOnly: false,
      nameStatus: false,
      noMerges: false,
      reverse: false,
    };
    let limit: number | undefined = undefined;
    let ref: string | undefined = undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--oneline') {
        options.oneline = true;
      } else if (arg === '--graph') {
        options.graph = true;
      } else if (arg === '--all') {
        // Not directly supported by isomorphic-git
      } else if (arg === '-p' || arg === '--patch') {
        options.patch = true;
      } else if (arg === '--stat') {
        options.stat = true;
      } else if (arg === '--name-only') {
        options.nameOnly = true;
      } else if (arg === '--name-status') {
        options.nameStatus = true;
      } else if (arg === '--no-merges') {
        options.noMerges = true;
      } else if (arg === '--reverse') {
        options.reverse = true;
      } else if (arg === '--format' || arg === '--pretty') {
        if (i + 1 < args.length) {
          options.format = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--format=')) {
        options.format = arg.substring(9);
      } else if (arg.startsWith('--pretty=')) {
        options.format = arg.substring(9);
      } else if (arg === '--author') {
        if (i + 1 < args.length) {
          options.author = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--author=')) {
        options.author = arg.substring(9);
      } else if (arg === '--grep') {
        if (i + 1 < args.length) {
          options.grep = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--grep=')) {
        options.grep = arg.substring(7);
      } else if (arg === '--since' || arg === '--after') {
        if (i + 1 < args.length) {
          options.since = this.parseDate(args[i + 1]);
          i++;
        }
      } else if (arg.startsWith('--since=') || arg.startsWith('--after=')) {
        options.since = this.parseDate(arg.substring(arg.indexOf('=') + 1));
      } else if (arg === '--until' || arg === '--before') {
        if (i + 1 < args.length) {
          options.until = this.parseDate(args[i + 1]);
          i++;
        }
      } else if (arg.startsWith('--until=') || arg.startsWith('--before=')) {
        options.until = this.parseDate(arg.substring(arg.indexOf('=') + 1));
      } else if (arg === '--follow') {
        if (i + 1 < args.length) {
          options.follow = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--follow=')) {
        options.follow = arg.substring(9);
      } else if (arg === '-n' || arg === '--max-count') {
        if (i + 1 < args.length) {
          const num = parseInt(args[i + 1], 10);
          if (!isNaN(num) && num > 0) {
            limit = num;
          }
          i++;
        }
      } else if (arg.startsWith('-n=')) {
        const num = parseInt(arg.substring(3), 10);
        if (!isNaN(num) && num > 0) {
          limit = num;
        }
      } else if (arg.startsWith('--max-count=')) {
        const num = parseInt(arg.substring(12), 10);
        if (!isNaN(num) && num > 0) {
          limit = num;
        }
      } else if (arg.match(/^-\d+$/)) {
        const num = parseInt(arg.substring(1), 10);
        if (!isNaN(num) && num > 0) {
          limit = num;
        }
      } else if (!arg.startsWith('-')) {
        ref = arg;
      }
    }

    return { options, limit, ref };
  }

  /**
   * Parse a date string into a Unix timestamp (seconds).
   * Supports absolute dates (ISO format) and relative dates ("2 weeks ago", "1 day ago").
   */
  private parseDate(str: string): number | undefined {
    // Try ISO/standard date parsing first
    const ts = Date.parse(str);
    if (!isNaN(ts)) return Math.floor(ts / 1000);

    // Try relative dates like "2 weeks ago", "yesterday"
    const now = Math.floor(Date.now() / 1000);
    const lower = str.toLowerCase().trim();

    if (lower === 'yesterday') return now - 86400;
    if (lower === 'today') return now - (now % 86400);

    const relMatch = lower.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
    if (relMatch) {
      const num = parseInt(relMatch[1], 10);
      const unit = relMatch[2];
      const secs: Record<string, number> = {
        second: 1,
        minute: 60,
        hour: 3600,
        day: 86400,
        week: 604800,
        month: 2592000,
        year: 31536000,
      };
      return now - num * secs[unit];
    }

    return undefined;
  }

  /**
   * Format a Unix timestamp into a git-style date string with timezone offset.
   */
  private formatGitDate(timestamp: number, tzOffset?: number): string {
    const date = new Date(timestamp * 1000);
    const offset = tzOffset ?? 0;
    const sign = offset <= 0 ? '+' : '-';
    const absOff = Math.abs(offset);
    const tzHours = Math.floor(absOff / 60).toString().padStart(2, '0');
    const tzMins = (absOff % 60).toString().padStart(2, '0');
    // Use UTC to get canonical git output
    return date.toUTCString().replace('GMT', `${sign}${tzHours}${tzMins}`);
  }

  /**
   * Get the files changed in a commit (comparing against parent).
   */
  private async getChangedFiles(commit: CommitInfo, cwd: string): Promise<Array<{ path: string; status: 'A' | 'M' | 'D' }>> {
    const changes: Array<{ path: string; status: 'A' | 'M' | 'D' }> = [];
    try {
      const parents = commit.commit.parent || [];
      if (parents.length === 0) {
        // Initial commit: all files are added
        const files = await this.listFilesInCommit(cwd, commit.oid);
        for (const f of files) {
          changes.push({ path: f, status: 'A' });
        }
      } else {
        const currentFiles = await this.getFileMap(cwd, commit.oid);
        const parentFiles = await this.getFileMap(cwd, parents[0]);
        // Find additions/modifications
        for (const [path, oid] of currentFiles) {
          const parentOid = parentFiles.get(path);
          if (!parentOid) changes.push({ path, status: 'A' });
          else if (parentOid !== oid) changes.push({ path, status: 'M' });
        }
        // Find deletions
        for (const path of parentFiles.keys()) {
          if (!currentFiles.has(path)) {
            changes.push({ path, status: 'D' });
          }
        }
      }
    } catch {
      // Ignore
    }
    return changes;
  }

  private async listFilesInCommit(cwd: string, commitOid: string): Promise<Set<string>> {
    const map = await this.getFileMap(cwd, commitOid);
    return new Set(map.keys());
  }

  private async getFileMap(cwd: string, commitOid: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (oid: string, prefix: string): Promise<void> => {
      try {
        const tree = await this.git.readTree({ dir: cwd, oid });
        for (const entry of tree.tree as Array<{ mode: string; path: string; oid: string; type?: string }>) {
          const path = prefix ? `${prefix}/${entry.path}` : entry.path;
          if (entry.mode === '040000' || entry.type === 'tree') {
            await walk(entry.oid, path);
          } else {
            files.set(path, entry.oid);
          }
        }
      } catch {
        // Ignore
      }
    };
    await walk(commitOid, '');
    return files;
  }

  private async formatLog(
    commits: CommitInfo[],
    format: string,
    options: LogOptions,
    cwd: string,
  ): Promise<ShellCommandResult> {
    const lines: string[] = [];

    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      const isLast = i === commits.length - 1;
      const graphPrefix = options.graph ? '* ' : '';

      // Handle format:<spec> pretty format
      if (format.startsWith('format:') || format.startsWith('tformat:')) {
        const spec = format.substring(format.indexOf(':') + 1);
        lines.push(this.formatCustom(commit, spec));
      } else {
        switch (format) {
          case 'oneline':
            lines.push(this.formatOneline(commit, graphPrefix));
            break;

          case 'short':
            lines.push(this.formatShort(commit, graphPrefix));
            if (!isLast) lines.push('');
            break;

          case 'medium':
          case 'full':
          default:
            lines.push(this.formatFull(commit, graphPrefix));
            if (!isLast) lines.push('');
            break;

          case 'fuller':
            lines.push(this.formatFuller(commit, graphPrefix));
            if (!isLast) lines.push('');
            break;

          case 'raw':
            lines.push(this.formatRaw(commit));
            if (!isLast) lines.push('');
            break;
        }
      }

      // Include file changes if requested
      if (options.stat || options.patch || options.nameOnly || options.nameStatus) {
        const changes = await this.getChangedFiles(commit, cwd);
        if (options.nameOnly) {
          for (const c of changes) lines.push(c.path);
        } else if (options.nameStatus) {
          for (const c of changes) lines.push(`${c.status}\t${c.path}`);
        } else if (options.stat) {
          lines.push('');
          for (const c of changes) {
            lines.push(` ${c.path} | ${c.status === 'A' ? '+' : c.status === 'D' ? '-' : 'M'}`);
          }
          lines.push(` ${changes.length} file${changes.length !== 1 ? 's' : ''} changed`);
        } else if (options.patch) {
          lines.push('');
          // Simple patch output: just show changed file names (full patch is expensive)
          for (const c of changes) {
            lines.push(`diff --git a/${c.path} b/${c.path}`);
            if (c.status === 'A') {
              lines.push('new file mode 100644');
            } else if (c.status === 'D') {
              lines.push('deleted file mode 100644');
            }
            lines.push(`--- ${c.status === 'A' ? '/dev/null' : `a/${c.path}`}`);
            lines.push(`+++ ${c.status === 'D' ? '/dev/null' : `b/${c.path}`}`);
          }
        }
        if (!isLast) lines.push('');
      }
    }

    return createSuccessResult(lines.join('\n') + '\n');
  }

  private formatCustom(commit: CommitInfo, spec: string): string {
    // Minimal pretty format placeholder support
    const placeholders: Record<string, string> = {
      '%H': commit.oid,
      '%h': commit.oid.substring(0, 7),
      '%an': commit.commit.author.name,
      '%ae': commit.commit.author.email,
      '%ad': this.formatGitDate(commit.commit.author.timestamp, commit.commit.author.timezoneOffset),
      '%at': String(commit.commit.author.timestamp),
      '%s': commit.commit.message.split('\n')[0],
      '%b': commit.commit.message.split('\n').slice(1).join('\n'),
      '%B': commit.commit.message,
      '%cn': commit.commit.committer?.name || commit.commit.author.name,
      '%ce': commit.commit.committer?.email || commit.commit.author.email,
      '%cd': this.formatGitDate(commit.commit.committer?.timestamp || commit.commit.author.timestamp, commit.commit.committer?.timezoneOffset),
      '%ct': String(commit.commit.committer?.timestamp || commit.commit.author.timestamp),
      '%P': (commit.commit.parent || []).join(' '),
      '%p': (commit.commit.parent || []).map(p => p.substring(0, 7)).join(' '),
      '%n': '\n',
      '%%': '%',
    };

    let result = spec;
    // Replace longer placeholders first to avoid partial replacements
    const keys = Object.keys(placeholders).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      result = result.split(key).join(placeholders[key]);
    }
    return result;
  }

  private formatOneline(commit: CommitInfo, graphPrefix: string): string {
    const shortHash = commit.oid.substring(0, 7);
    const message = commit.commit.message.split('\n')[0];
    return `${graphPrefix}${shortHash} ${message}`;
  }

  private formatShort(commit: CommitInfo, graphPrefix: string): string {
    const lines: string[] = [];
    const shortHash = commit.oid.substring(0, 7);

    lines.push(`${graphPrefix}commit ${shortHash}`);
    lines.push(`Author: ${commit.commit.author.name} <${commit.commit.author.email}>`);
    lines.push('');

    const messageLines = commit.commit.message.split('\n');
    for (const messageLine of messageLines) {
      lines.push(`    ${messageLine}`);
    }

    return lines.join('\n');
  }

  private formatFull(commit: CommitInfo, graphPrefix: string): string {
    const lines: string[] = [];
    lines.push(`${graphPrefix}commit ${commit.oid}`);
    const author = commit.commit.author;
    lines.push(`Author: ${author.name} <${author.email}>`);
    lines.push(`Date:   ${this.formatGitDate(author.timestamp, author.timezoneOffset)}`);
    lines.push('');
    const messageLines = commit.commit.message.split('\n');
    for (const messageLine of messageLines) {
      lines.push(`    ${messageLine}`);
    }
    return lines.join('\n');
  }

  private formatFuller(commit: CommitInfo, graphPrefix: string): string {
    const lines: string[] = [];
    lines.push(`${graphPrefix}commit ${commit.oid}`);
    const author = commit.commit.author;
    lines.push(`Author:     ${author.name} <${author.email}>`);
    lines.push(`AuthorDate: ${this.formatGitDate(author.timestamp, author.timezoneOffset)}`);
    if (commit.commit.committer) {
      const committer = commit.commit.committer;
      lines.push(`Commit:     ${committer.name} <${committer.email}>`);
      lines.push(`CommitDate: ${this.formatGitDate(committer.timestamp, committer.timezoneOffset)}`);
    }
    lines.push('');
    const messageLines = commit.commit.message.split('\n');
    for (const messageLine of messageLines) {
      lines.push(`    ${messageLine}`);
    }
    return lines.join('\n');
  }

  private formatRaw(commit: CommitInfo): string {
    const lines: string[] = [];
    lines.push(`commit ${commit.oid}`);
    const author = commit.commit.author;
    const authorTz = this.gitTzString(author.timezoneOffset);
    lines.push(`author ${author.name} <${author.email}> ${author.timestamp} ${authorTz}`);
    if (commit.commit.committer) {
      const committer = commit.commit.committer;
      const committerTz = this.gitTzString(committer.timezoneOffset);
      lines.push(`committer ${committer.name} <${committer.email}> ${committer.timestamp} ${committerTz}`);
    }
    lines.push('');
    lines.push(commit.commit.message);
    return lines.join('\n');
  }

  private gitTzString(tzOffset?: number): string {
    const offset = tzOffset ?? 0;
    const sign = offset <= 0 ? '+' : '-';
    const absOff = Math.abs(offset);
    const h = Math.floor(absOff / 60).toString().padStart(2, '0');
    const m = (absOff % 60).toString().padStart(2, '0');
    return `${sign}${h}${m}`;
  }
}
