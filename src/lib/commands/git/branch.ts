import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

interface BranchOptions {
  force: boolean;
  all: boolean;
  remote: boolean;
  verbose: boolean;
  showCurrent: boolean;
}

type BranchAction = 'list' | 'create' | 'delete' | 'rename' | 'show-current';

export class GitBranchCommand implements GitSubcommand {
  name = 'branch';
  description = 'List, create, or delete branches';
  usage = 'git branch [--list | -a | -r | -v | --show-current] | git branch <branchname> [<start-point>] | git branch (-d | -D) <branchname> | git branch (-m | -M) [<oldname>] <newname>';

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

      const { action, branchName, startPoint, newName, options } = this.parseArgs(args);

      switch (action) {
        case 'list':
          return await this.listBranches(options, cwd);
        case 'show-current':
          return await this.showCurrentBranch(cwd);
        case 'create':
          return await this.createBranch(branchName!, startPoint, cwd);
        case 'delete':
          return await this.deleteBranch(branchName!, options.force, cwd);
        case 'rename':
          return await this.renameBranch(branchName, newName!, options.force, cwd);
        default:
          return await this.listBranches(options, cwd);
      }

    } catch (error) {
      return createErrorResult(`git branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    action: BranchAction;
    branchName?: string;
    startPoint?: string;
    newName?: string;
    options: BranchOptions;
  } {
    const options: BranchOptions = {
      force: false,
      all: false,
      remote: false,
      verbose: false,
      showCurrent: false,
    };
    let action: BranchAction = 'list';
    let branchName: string | undefined;
    let startPoint: string | undefined;
    let newName: string | undefined;
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--list' || arg === '-l') {
        action = 'list';
      } else if (arg === '-a' || arg === '--all') {
        options.all = true;
        action = 'list';
      } else if (arg === '-r' || arg === '--remotes') {
        options.remote = true;
        action = 'list';
      } else if (arg === '-v' || arg === '--verbose') {
        options.verbose = true;
      } else if (arg === '--show-current') {
        action = 'show-current';
      } else if (arg === '-d' || arg === '--delete') {
        action = 'delete';
      } else if (arg === '-D') {
        action = 'delete';
        options.force = true;
      } else if (arg === '-m' || arg === '--move') {
        action = 'rename';
      } else if (arg === '-M') {
        action = 'rename';
        options.force = true;
      } else if (arg === '-f' || arg === '--force') {
        options.force = true;
      } else if (!arg.startsWith('-')) {
        positionals.push(arg);
      }
    }

    if (action === 'delete') {
      branchName = positionals[0];
    } else if (action === 'rename') {
      if (positionals.length === 1) {
        newName = positionals[0];
      } else if (positionals.length >= 2) {
        branchName = positionals[0];
        newName = positionals[1];
      }
    } else if (positionals.length >= 1) {
      action = 'create';
      branchName = positionals[0];
      if (positionals.length >= 2) {
        startPoint = positionals[1];
      }
    }

    return { action, branchName, startPoint, newName, options };
  }

  private async showCurrentBranch(cwd: string): Promise<ShellCommandResult> {
    try {
      const currentBranch = await this.git.currentBranch({ dir: cwd });
      if (!currentBranch) {
        return createSuccessResult('');
      }
      return createSuccessResult(`${currentBranch}\n`);
    } catch {
      return createSuccessResult('');
    }
  }

  private async listBranches(options: BranchOptions, cwd: string): Promise<ShellCommandResult> {
    try {
      const lines: string[] = [];

      // Get current branch
      let currentBranch: string | null = null;
      try {
        currentBranch = await this.git.currentBranch({ dir: cwd }) || null;
      } catch {
        // Detached HEAD
      }

      const listLocal = !options.remote || options.all;
      const listRemote = options.remote || options.all;

      if (listLocal) {
        const branches = await this.git.listBranches({ dir: cwd });
        for (const branch of branches) {
          const prefix = branch === currentBranch ? '* ' : '  ';
          let line = `${prefix}${branch}`;
          if (options.verbose) {
            try {
              const oid = await this.git.resolveRef({ dir: cwd, ref: branch });
              line += ` ${oid.substring(0, 7)}`;
              // Get commit message
              try {
                const log = await this.git.log({ dir: cwd, depth: 1, ref: branch });
                if (log.length > 0) {
                  line += ` ${log[0].commit.message.split('\n')[0]}`;
                }
              } catch { /* empty */ }
            } catch { /* empty */ }
          }
          lines.push(line);
        }
      }

      if (listRemote) {
        try {
          const remotes = await this.git.listRemotes({ dir: cwd });
          for (const remote of remotes) {
            try {
              const remoteBranches = await this.git.listBranches({ dir: cwd, remote: remote.remote });
              for (const branch of remoteBranches) {
                lines.push(`  remotes/${remote.remote}/${branch}`);
              }
            } catch { /* empty */ }
          }
        } catch { /* empty */ }
      }

      if (lines.length === 0) {
        return createSuccessResult('');
      }

      return createSuccessResult(lines.join('\n') + '\n');
    } catch (error) {
      return createErrorResult(`Failed to list branches: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createBranch(branchName: string, startPoint: string | undefined, cwd: string): Promise<ShellCommandResult> {
    try {
      // Check if branch already exists
      const branches = await this.git.listBranches({ dir: cwd });

      if (branches.includes(branchName)) {
        return createErrorResult(`fatal: A branch named '${branchName}' already exists.`);
      }

      // Get starting ref
      let startOid: string;
      try {
        startOid = await this.git.resolveRef({
          dir: cwd,
          ref: startPoint || 'HEAD',
        });
      } catch {
        return createErrorResult(`fatal: Not a valid object name: '${startPoint || 'HEAD'}'.`);
      }

      // Create the new branch
      await this.git.branch({
        dir: cwd,
        ref: branchName,
        object: startOid,
      });

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to create branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async deleteBranch(branchName: string, force: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      // Check if branch exists
      const branches = await this.git.listBranches({ dir: cwd });

      if (!branches.includes(branchName)) {
        return createErrorResult(`error: branch '${branchName}' not found.`);
      }

      // Check if it's the current branch
      let currentBranch: string | null = null;
      try {
        currentBranch = await this.git.currentBranch({ dir: cwd }) || null;
      } catch {
        // Continue
      }

      if (currentBranch === branchName) {
        return createErrorResult(`error: Cannot delete branch '${branchName}' checked out at '${cwd}'`);
      }

      // Delete the branch
      await this.git.deleteBranch({
        dir: cwd,
        ref: branchName,
      });

      return createSuccessResult(`Deleted branch ${branchName}.\n`);

    } catch (error) {
      if (!force && error instanceof Error && error.message.includes('not fully merged')) {
        return createErrorResult(`error: The branch '${branchName}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${branchName}'.`);
      }
      return createErrorResult(`Failed to delete branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async renameBranch(
    oldName: string | undefined,
    newName: string,
    force: boolean,
    cwd: string
  ): Promise<ShellCommandResult> {
    try {
      // If oldName not specified, rename the current branch
      let actualOldName = oldName;
      if (!actualOldName) {
        try {
          actualOldName = await this.git.currentBranch({ dir: cwd }) || undefined;
          if (!actualOldName) {
            return createErrorResult('fatal: Cannot rename the current branch while not on any.');
          }
        } catch {
          return createErrorResult('fatal: Cannot determine current branch.');
        }
      }

      const branches = await this.git.listBranches({ dir: cwd });
      if (!branches.includes(actualOldName)) {
        return createErrorResult(`error: refname refs/heads/${actualOldName} not found`);
      }
      if (!force && branches.includes(newName)) {
        return createErrorResult(`fatal: A branch named '${newName}' already exists.`);
      }

      await this.git.renameBranch({
        dir: cwd,
        ref: newName,
        oldref: actualOldName,
      });

      return createSuccessResult('');
    } catch (error) {
      return createErrorResult(`Failed to rename branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
