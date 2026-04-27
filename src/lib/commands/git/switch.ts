import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

/**
 * `git switch` is the modern replacement for `git checkout <branch>`.
 * Only switches branches; doesn't restore files.
 */
export class GitSwitchCommand implements GitSubcommand {
  name = 'switch';
  description = 'Switch branches';
  usage = 'git switch [-c | -C] [--detach] [--force] <branch> | git switch - (switch to previous branch)';

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

      const { target, startPoint, options } = this.parseArgs(args);

      if (!target) {
        return createErrorResult('fatal: missing branch or commit argument');
      }

      // Handle "switch to previous branch"
      if (target === '-') {
        return createErrorResult('fatal: switch to previous branch is not supported');
      }

      const branches = await this.git.listBranches({ dir: cwd });
      const isBranch = branches.includes(target);

      if (options.create || options.createOrReset) {
        if (isBranch && !options.createOrReset) {
          return createErrorResult(`fatal: A branch named '${target}' already exists.`);
        }

        if (isBranch && options.createOrReset) {
          try {
            await this.git.deleteBranch({ dir: cwd, ref: target });
          } catch {
            // Continue
          }
        }

        let startOid: string;
        try {
          startOid = await this.git.resolveRef({ dir: cwd, ref: startPoint || 'HEAD' });
        } catch {
          return createErrorResult(`fatal: invalid reference: ${startPoint || 'HEAD'}`);
        }

        await this.git.branch({ dir: cwd, ref: target, object: startOid });

        await this.git.checkout({ dir: cwd, ref: target, force: options.force });

        return createSuccessResult(`Switched to a new branch '${target}'\n`);
      }

      if (!isBranch && !options.detach) {
        return createErrorResult(`fatal: invalid reference: ${target}`);
      }

      // Check for uncommitted changes unless --force
      if (!options.force) {
        const statusMatrix = await this.git.statusMatrix({ dir: cwd });
        const hasChanges = statusMatrix.some(([, headStatus, workdirStatus, stageStatus]) => {
          if (headStatus === 0 && stageStatus === 0) return false;
          return headStatus !== workdirStatus || headStatus !== stageStatus;
        });
        if (hasChanges) {
          return createErrorResult('error: Your local changes to the following files would be overwritten by checkout:\nPlease commit your changes or stash them before you switch branches.');
        }
      }

      let currentBranch: string | null = null;
      try {
        currentBranch = await this.git.currentBranch({ dir: cwd }) || null;
      } catch { /* empty */ }

      if (isBranch && currentBranch === target) {
        return createSuccessResult(`Already on '${target}'\n`);
      }

      await this.git.checkout({ dir: cwd, ref: target, force: options.force });

      return createSuccessResult(isBranch
        ? `Switched to branch '${target}'\n`
        : `HEAD is now at ${target.substring(0, 7)}\n`);
    } catch (error) {
      return createErrorResult(`git switch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    target?: string;
    startPoint?: string;
    options: { create: boolean; createOrReset: boolean; detach: boolean; force: boolean };
  } {
    const options = { create: false, createOrReset: false, detach: false, force: false };
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-c' || arg === '--create') {
        options.create = true;
      } else if (arg === '-C' || arg === '--force-create') {
        options.createOrReset = true;
      } else if (arg === '--detach' || arg === '-d') {
        options.detach = true;
      } else if (arg === '--force' || arg === '-f' || arg === '--discard-changes') {
        options.force = true;
      } else if (!arg.startsWith('-')) {
        positionals.push(arg);
      }
    }

    const target = positionals[0];
    const startPoint = positionals[1];
    return { target, startPoint, options };
  }
}
