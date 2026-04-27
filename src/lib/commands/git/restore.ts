import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitRestoreCommand implements GitSubcommand {
  name = 'restore';
  description = 'Restore working tree files';
  usage = 'git restore [--source=<tree>] [--staged] [--worktree] [<path>...]';

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
        return createErrorResult('fatal: you must specify path(s) to restore');
      }

      // Default behavior: restore working tree from index
      // With --staged: restore index from HEAD (or source)
      // With both --staged and --worktree: restore both
      const restoreWorktree = options.worktree || !options.staged;
      const restoreStaged = options.staged;

      if (restoreStaged) {
        // Reset index entries to match HEAD (or source)
        for (const filepath of paths) {
          try {
            await this.git.resetIndex({ dir: cwd, filepath });
          } catch {
            return createErrorResult(`error: pathspec '${filepath}' did not match any file(s) known to git`);
          }
        }
      }

      if (restoreWorktree) {
        const source = options.source || 'HEAD';
        try {
          await this.git.checkout({
            dir: cwd,
            ref: source,
            filepaths: paths,
            force: true,
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes('does not exist')) {
            return createErrorResult(`error: pathspec did not match any file(s) known to git`);
          }
          return createErrorResult(`Failed to restore: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      return createSuccessResult('');
    } catch (error) {
      return createErrorResult(`git restore: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    paths: string[];
    options: { source?: string; staged: boolean; worktree: boolean };
  } {
    const options: { source?: string; staged: boolean; worktree: boolean } = {
      staged: false,
      worktree: false,
    };
    const paths: string[] = [];
    let foundDoubleDash = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') {
        foundDoubleDash = true;
        continue;
      }
      if (foundDoubleDash) {
        paths.push(arg);
      } else if (arg === '--staged' || arg === '-S') {
        options.staged = true;
      } else if (arg === '--worktree' || arg === '-W') {
        options.worktree = true;
      } else if (arg === '--source' || arg === '-s') {
        if (i + 1 < args.length) {
          options.source = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--source=')) {
        options.source = arg.substring(9);
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    return { paths, options };
  }
}
