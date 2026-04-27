import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitLsFilesCommand implements GitSubcommand {
  name = 'ls-files';
  description = 'Show information about files in the index and the working tree';
  usage = 'git ls-files [-m|--modified] [-o|--others] [-d|--deleted] [-s|--stage] [--] [<path>...]';

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

      const statusMatrix = await this.git.statusMatrix({ dir: cwd });

      const matchesPaths = (filepath: string): boolean => {
        if (paths.length === 0) return true;
        return paths.some(p => p === '.' || filepath === p || filepath.startsWith(p + '/'));
      };

      const lines: string[] = [];
      const anyFilter = options.modified || options.others || options.deleted;

      for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
        if (!matchesPaths(filepath)) continue;

        const isTracked = headStatus === 1 || stageStatus !== 0;
        const isModified = (headStatus === 1 && (workdirStatus !== 1 || stageStatus !== 1));
        const isDeleted = isTracked && workdirStatus === 0;
        const isUntracked = headStatus === 0 && stageStatus === 0 && workdirStatus === 2;

        if (anyFilter) {
          if (options.modified && isModified && !isDeleted) {
            lines.push(filepath);
          }
          if (options.deleted && isDeleted) {
            lines.push(filepath);
          }
          if (options.others && isUntracked) {
            lines.push(filepath);
          }
        } else {
          // Default: show tracked files (cached)
          if (isTracked) {
            if (options.stage) {
              try {
                const head = await this.git.resolveRef({ dir: cwd, ref: 'HEAD' });
                const blob = await this.git.readBlob({ dir: cwd, oid: head, filepath });
                lines.push(`100644 ${blob.oid} 0\t${filepath}`);
              } catch {
                lines.push(`100644 0000000000000000000000000000000000000000 0\t${filepath}`);
              }
            } else {
              lines.push(filepath);
            }
          }
        }
      }

      return createSuccessResult(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    } catch (error) {
      return createErrorResult(`git ls-files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    paths: string[];
    options: {
      modified: boolean;
      others: boolean;
      deleted: boolean;
      stage: boolean;
      cached: boolean;
    };
  } {
    const options = {
      modified: false,
      others: false,
      deleted: false,
      stage: false,
      cached: false,
    };
    const paths: string[] = [];
    let foundDoubleDash = false;

    for (const arg of args) {
      if (arg === '--') {
        foundDoubleDash = true;
        continue;
      }
      if (foundDoubleDash) {
        paths.push(arg);
      } else if (arg === '-m' || arg === '--modified') {
        options.modified = true;
      } else if (arg === '-o' || arg === '--others') {
        options.others = true;
      } else if (arg === '-d' || arg === '--deleted') {
        options.deleted = true;
      } else if (arg === '-s' || arg === '--stage') {
        options.stage = true;
      } else if (arg === '-c' || arg === '--cached') {
        options.cached = true;
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    return { paths, options };
  }
}
