import { join, dirname, isAbsolute, relative } from "path-browserify";
import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitMvCommand implements GitSubcommand {
  name = 'mv';
  description = 'Move or rename a file, a directory, or a symlink';
  usage = 'git mv [-f | --force] [-k] [-n | --dry-run] [-v | --verbose] <source>... <destination>';

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

      const { sources, destination, options } = this.parseArgs(args);

      if (sources.length === 0 || !destination) {
        return createErrorResult('usage: git mv [-f] [-n] <source>... <destination>');
      }

      const normDest = this.normalizePath(destination, cwd);
      if (normDest === null) {
        return createErrorResult(`fatal: ${destination}: destination is outside repository`);
      }
      const destAbs = join(cwd, normDest);

      // Check if destination is a directory
      let destIsDir = false;
      try {
        const stats = await this.fs.stat(destAbs);
        destIsDir = stats.isDirectory();
      } catch {
        // Doesn't exist
      }

      if (sources.length > 1 && !destIsDir) {
        return createErrorResult(`fatal: destination '${destination}' is not a directory`);
      }

      const moves: string[] = [];

      for (const source of sources) {
        const normSrc = this.normalizePath(source, cwd);
        if (normSrc === null) {
          return createErrorResult(`fatal: ${source}: source is outside repository`);
        }
        const srcAbs = join(cwd, normSrc);

        // Source must exist
        try {
          await this.fs.stat(srcAbs);
        } catch {
          return createErrorResult(`fatal: bad source, source=${source}, destination=${destination}`);
        }

        // Determine final destination for this source
        let finalDest: string;
        let finalDestAbs: string;
        if (destIsDir) {
          const basename = normSrc.split('/').pop()!;
          finalDest = join(normDest, basename);
          finalDestAbs = join(cwd, finalDest);
        } else {
          finalDest = normDest;
          finalDestAbs = destAbs;
        }

        // Check destination existence (unless --force)
        if (!options.force) {
          try {
            await this.fs.stat(finalDestAbs);
            return createErrorResult(`fatal: destination exists, source=${source}, destination=${finalDest}`);
          } catch {
            // OK
          }
        }

        if (!options.dryRun) {
          // Ensure destination directory exists
          const destDir = dirname(finalDestAbs);
          try {
            await this.fs.mkdir(destDir, { recursive: true });
          } catch {
            // Probably already exists
          }

          // Move file on disk
          await this.fs.rename(srcAbs, finalDestAbs);

          // Update git index
          try {
            await this.git.remove({ dir: cwd, filepath: normSrc });
          } catch {
            // Might not have been tracked
          }
          try {
            await this.git.add({ dir: cwd, filepath: finalDest });
          } catch {
            // Continue
          }
        }

        moves.push(`Renaming ${normSrc} to ${finalDest}`);
      }

      if (options.verbose || options.dryRun) {
        return createSuccessResult(moves.join('\n') + '\n');
      }
      return createSuccessResult('');
    } catch (error) {
      return createErrorResult(`git mv: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    sources: string[];
    destination?: string;
    options: { force: boolean; dryRun: boolean; verbose: boolean; keep: boolean };
  } {
    const options = { force: false, dryRun: false, verbose: false, keep: false };
    const positionals: string[] = [];

    for (const arg of args) {
      if (arg === '-f' || arg === '--force') {
        options.force = true;
      } else if (arg === '-n' || arg === '--dry-run') {
        options.dryRun = true;
      } else if (arg === '-v' || arg === '--verbose') {
        options.verbose = true;
      } else if (arg === '-k') {
        options.keep = true;
      } else if (!arg.startsWith('-')) {
        positionals.push(arg);
      }
    }

    if (positionals.length < 2) {
      return { sources: positionals, destination: undefined, options };
    }

    const destination = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    return { sources, destination, options };
  }
}
