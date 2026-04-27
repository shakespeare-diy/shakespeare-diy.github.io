import { join, isAbsolute, relative } from "path-browserify";
import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitRmCommand implements GitSubcommand {
  name = 'rm';
  description = 'Remove files from the working tree and from the index';
  usage = 'git rm [-f | --force] [-r] [--cached] [--dry-run | -n] [--] <file>...';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      try {
        await this.fs.stat(`${cwd}/.git`);
      } catch {
        return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
      }

      const { paths, options } = this.parseArgs(args);

      if (paths.length === 0) {
        return createErrorResult('fatal: No pathspec was given. Which files should I remove?');
      }

      const removed: string[] = [];
      const errors: string[] = [];

      for (const path of paths) {
        const normalized = this.normalizePath(path, cwd);
        if (normalized === null) {
          errors.push(`fatal: ${path}: '${path}' is outside repository`);
          continue;
        }

        const absPath = join(cwd, normalized);

        let isDir = false;
        try {
          const stats = await this.fs.stat(absPath);
          isDir = stats.isDirectory();
        } catch {
          // File doesn't exist on disk - might still be in index
        }

        if (isDir && !options.recursive) {
          errors.push(`fatal: not removing '${path}' recursively without -r`);
          continue;
        }

        const filesToRemove: string[] = [];
        if (isDir) {
          // Collect all files in the directory
          await this.collectFiles(absPath, normalized, filesToRemove);
        } else {
          filesToRemove.push(normalized);
        }

        for (const file of filesToRemove) {
          try {
            if (!options.dryRun) {
              // Remove from index
              await this.git.remove({ dir: cwd, filepath: file });
              // Remove from working tree unless --cached
              if (!options.cached) {
                try {
                  await this.fs.unlink(join(cwd, file));
                } catch {
                  // File might not exist on disk
                }
              }
            }
            removed.push(file);
          } catch {
            errors.push(`fatal: pathspec '${file}' did not match any files`);
          }
        }
      }

      if (errors.length > 0 && removed.length === 0) {
        return createErrorResult(errors.join('\n'));
      }

      const output = removed.map(f => `rm '${f}'`).join('\n');
      return createSuccessResult(output + (output ? '\n' : ''));
    } catch (error) {
      return createErrorResult(`git rm: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async collectFiles(absPath: string, relPath: string, out: string[]): Promise<void> {
    try {
      const entries = await this.fs.readdir(absPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const entryAbs = join(absPath, entry.name);
        const entryRel = join(relPath, entry.name);
        if (entry.isDirectory()) {
          await this.collectFiles(entryAbs, entryRel, out);
        } else {
          out.push(entryRel);
        }
      }
    } catch {
      // Ignore
    }
  }

  private normalizePath(path: string, cwd: string): string | null {
    if (isAbsolute(path)) {
      if (!path.startsWith(cwd)) return null;
      const rel = relative(cwd, path);
      return rel || '.';
    }
    return path;
  }

  private parseArgs(args: string[]): {
    paths: string[];
    options: { force: boolean; recursive: boolean; cached: boolean; dryRun: boolean };
  } {
    const options = { force: false, recursive: false, cached: false, dryRun: false };
    const paths: string[] = [];
    let foundDoubleDash = false;

    for (const arg of args) {
      if (arg === '--') {
        foundDoubleDash = true;
        continue;
      }
      if (foundDoubleDash) {
        paths.push(arg);
      } else if (arg === '-f' || arg === '--force') {
        options.force = true;
      } else if (arg === '-r' || arg === '-R') {
        options.recursive = true;
      } else if (arg === '--cached') {
        options.cached = true;
      } else if (arg === '-n' || arg === '--dry-run') {
        options.dryRun = true;
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    return { paths, options };
  }
}
