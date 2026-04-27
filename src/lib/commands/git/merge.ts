import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitMergeCommand implements GitSubcommand {
  name = 'merge';
  description = 'Join two or more development histories together';
  usage = 'git merge [--ff | --no-ff | --ff-only] [-m <msg>] [--abort] <commit>...';

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

      const { branches, options } = this.parseArgs(args);

      if (options.abort) {
        try {
          await this.git.abortMerge({ dir: cwd });
          return createSuccessResult('');
        } catch (error) {
          return createErrorResult(`Failed to abort merge: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      if (branches.length === 0) {
        return createErrorResult('fatal: No commit specified');
      }

      if (branches.length > 1) {
        return createErrorResult('Octopus merges are not supported');
      }

      const theirs = branches[0];

      // Get current branch
      let currentBranch: string | null = null;
      try {
        currentBranch = await this.git.currentBranch({ dir: cwd }) || null;
      } catch {
        // Detached HEAD
      }

      if (!currentBranch) {
        return createErrorResult('fatal: Not currently on a branch.');
      }

      try {
        const result = await this.git.merge({
          dir: cwd,
          ours: currentBranch,
          theirs,
          fastForwardOnly: options.ffOnly,
          message: options.message,
        } as Parameters<typeof this.git.merge>[0]);

        if ((result as { alreadyMerged?: boolean }).alreadyMerged) {
          return createSuccessResult('Already up to date.\n');
        }
        if ((result as { fastForward?: boolean }).fastForward) {
          return createSuccessResult(`Fast-forward\n`);
        }
        return createSuccessResult(`Merge made by the 'recursive' strategy.\n`);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('conflict')) {
            return createErrorResult('error: Merge conflict. Please resolve conflicts manually.');
          }
          if (error.message.includes('fast-forward')) {
            return createErrorResult('fatal: Not possible to fast-forward, aborting.');
          }
        }
        return createErrorResult(`Failed to merge: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } catch (error) {
      return createErrorResult(`git merge: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    branches: string[];
    options: { ffOnly: boolean; noFf: boolean; abort: boolean; message?: string };
  } {
    const options: { ffOnly: boolean; noFf: boolean; abort: boolean; message?: string } = {
      ffOnly: false,
      noFf: false,
      abort: false,
    };
    const branches: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--ff-only') {
        options.ffOnly = true;
      } else if (arg === '--no-ff') {
        options.noFf = true;
      } else if (arg === '--ff') {
        // Default behavior
      } else if (arg === '--abort') {
        options.abort = true;
      } else if (arg === '-m' || arg === '--message') {
        if (i + 1 < args.length) {
          options.message = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--message=')) {
        options.message = arg.substring(10);
      } else if (!arg.startsWith('-')) {
        branches.push(arg);
      }
    }

    return { branches, options };
  }
}
