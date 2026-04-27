import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

interface CheckoutOptions {
  createBranch: boolean;
  createOrReset: boolean;
  force: boolean;
}

type CheckoutAction = 'switch' | 'create' | 'restore';

export class GitCheckoutCommand implements GitSubcommand {
  name = 'checkout';
  description = 'Switch branches or restore working tree files';
  usage = 'git checkout [-f] <branch-or-commit> | git checkout (-b | -B) <new-branch> [<start-point>] | git checkout [<tree-ish>] -- <file>...';

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

      const { action, target, startPoint, filepaths, options } = this.parseArgs(args);

      if (filepaths.length > 0) {
        return await this.restoreFiles(filepaths, target, cwd);
      }

      switch (action) {
        case 'switch':
          return await this.switchRef(target!, options, cwd);
        case 'create':
          return await this.createAndSwitchBranch(target!, startPoint, options, cwd);
        default:
          return createErrorResult('error: pathspec did not match any file(s) known to git');
      }

    } catch (error) {
      return createErrorResult(`git checkout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    action: CheckoutAction;
    target?: string;
    startPoint?: string;
    filepaths: string[];
    options: CheckoutOptions;
  } {
    const options: CheckoutOptions = {
      createBranch: false,
      createOrReset: false,
      force: false,
    };
    let action: CheckoutAction = 'switch';
    let target: string | undefined;
    let startPoint: string | undefined;
    const filepaths: string[] = [];
    const positionals: string[] = [];
    let foundDoubleDash = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (foundDoubleDash) {
        filepaths.push(arg);
        continue;
      }

      if (arg === '--') {
        foundDoubleDash = true;
        continue;
      } else if (arg === '-b') {
        action = 'create';
        options.createBranch = true;
      } else if (arg === '-B') {
        action = 'create';
        options.createOrReset = true;
      } else if (arg === '-f' || arg === '--force') {
        options.force = true;
      } else if (!arg.startsWith('-')) {
        positionals.push(arg);
      }
    }

    if (action === 'create') {
      target = positionals[0];
      if (positionals.length >= 2) {
        startPoint = positionals[1];
      }
    } else {
      target = positionals[0];
    }

    return { action, target, startPoint, filepaths, options };
  }

  /**
   * Switch to a branch or commit.
   */
  private async switchRef(ref: string, options: CheckoutOptions, cwd: string): Promise<ShellCommandResult> {
    try {
      const branches = await this.git.listBranches({ dir: cwd });
      const isBranch = branches.includes(ref);

      // Verify the ref exists (either as a branch or as a commit)
      if (!isBranch) {
        try {
          await this.git.resolveRef({ dir: cwd, ref });
        } catch {
          // Try to match as a commit hash
          if (!/^[a-f0-9]{4,40}$/.test(ref)) {
            return createErrorResult(`error: pathspec '${ref}' did not match any file(s) known to git`);
          }
          try {
            await this.git.readCommit({ dir: cwd, oid: ref });
          } catch {
            return createErrorResult(`error: pathspec '${ref}' did not match any file(s) known to git`);
          }
        }
      }

      // Get current branch
      let currentBranch: string | null = null;
      try {
        currentBranch = await this.git.currentBranch({ dir: cwd }) || null;
      } catch {
        // Continue
      }

      if (isBranch && currentBranch === ref) {
        return createSuccessResult(`Already on '${ref}'\n`);
      }

      // Check for uncommitted changes unless --force
      if (!options.force) {
        const statusMatrix = await this.git.statusMatrix({ dir: cwd });
        const hasChanges = statusMatrix.some(([, headStatus, workdirStatus, stageStatus]) => {
          // Ignore untracked files
          if (headStatus === 0 && stageStatus === 0) return false;
          return headStatus !== workdirStatus || headStatus !== stageStatus;
        });

        if (hasChanges) {
          return createErrorResult('error: Your local changes to the following files would be overwritten by checkout:\nPlease commit your changes or stash them before you switch branches.');
        }
      }

      // Switch
      await this.git.checkout({
        dir: cwd,
        ref,
        force: options.force,
      });

      if (isBranch) {
        return createSuccessResult(`Switched to branch '${ref}'\n`);
      } else {
        // Detached HEAD
        return createSuccessResult(`Note: switching to '${ref}'.\n\nYou are in 'detached HEAD' state.\nHEAD is now at ${ref.substring(0, 7)}\n`);
      }
    } catch (error) {
      return createErrorResult(`Failed to switch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createAndSwitchBranch(
    branchName: string,
    startPoint: string | undefined,
    options: CheckoutOptions,
    cwd: string
  ): Promise<ShellCommandResult> {
    try {
      const branches = await this.git.listBranches({ dir: cwd });

      if (branches.includes(branchName)) {
        if (!options.createOrReset) {
          return createErrorResult(`fatal: A branch named '${branchName}' already exists.`);
        }
        // -B: reset the existing branch
        try {
          await this.git.deleteBranch({ dir: cwd, ref: branchName });
        } catch {
          // Continue
        }
      }

      // Resolve start point
      let startOid: string;
      try {
        startOid = await this.git.resolveRef({
          dir: cwd,
          ref: startPoint || 'HEAD',
        });
      } catch {
        return createErrorResult(`fatal: Not a valid object name: '${startPoint || 'HEAD'}'.`);
      }

      // Create the branch
      await this.git.branch({
        dir: cwd,
        ref: branchName,
        object: startOid,
      });

      // Switch to the new branch
      await this.git.checkout({
        dir: cwd,
        ref: branchName,
        force: options.force,
      });

      return createSuccessResult(`Switched to a new branch '${branchName}'\n`);

    } catch (error) {
      return createErrorResult(`Failed to create and switch branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async restoreFiles(filepaths: string[], treeish: string | undefined, cwd: string): Promise<ShellCommandResult> {
    try {
      const ref = treeish || 'HEAD';
      try {
        await this.git.checkout({
          dir: cwd,
          ref,
          filepaths,
          force: true,
        });

        return createSuccessResult('');
      } catch (error) {
        if (error instanceof Error && error.message.includes('does not exist')) {
          return createErrorResult(`error: pathspec did not match any file(s) known to git`);
        }
        throw error;
      }

    } catch (error) {
      return createErrorResult(`Failed to restore files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
