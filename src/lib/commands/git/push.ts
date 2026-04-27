import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

interface PushOptions {
  force: boolean;
  setUpstream: boolean;
  tags: boolean;
  deleteRef: boolean;
  dryRun: boolean;
  all: boolean;
}

export class GitPushCommand implements GitSubcommand {
  name = 'push';
  description = 'Update remote refs along with associated objects';
  usage = 'git push [-u | --set-upstream] [-f | --force] [--tags] [--delete] [--dry-run] [--all] [<remote>] [<refspec>]';

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

      const { remote, refspec, options } = this.parseArgs(args);

      // Parse refspec (local:remote or just local, or HEAD)
      let localRef: string | undefined;
      let remoteRef: string | undefined;
      if (refspec) {
        if (refspec.includes(':')) {
          const [l, r] = refspec.split(':');
          localRef = l || undefined;
          remoteRef = r || undefined;
        } else {
          localRef = refspec;
          remoteRef = refspec;
        }
      }

      // Resolve HEAD to current branch if localRef is HEAD or not specified
      if (!localRef || localRef === 'HEAD') {
        try {
          const currentBranch = await this.git.currentBranch({ dir: cwd });
          if (!currentBranch) {
            return createErrorResult('fatal: You are not currently on a branch.');
          }
          if (!localRef) {
            localRef = currentBranch;
          }
          if (!remoteRef) {
            remoteRef = currentBranch;
          }
        } catch {
          return createErrorResult('fatal: You are not currently on a branch.');
        }
      }

      // Get remote URL
      let remoteUrl: string;
      try {
        const remotes = await this.git.listRemotes({ dir: cwd });
        const targetRemote = remotes.find(r => r.remote === remote);
        if (!targetRemote) {
          return createErrorResult(`fatal: '${remote}' does not appear to be a git repository`);
        }
        remoteUrl = targetRemote.url;
      } catch {
        return createErrorResult(`fatal: '${remote}' does not appear to be a git repository`);
      }

      if (options.dryRun) {
        return createSuccessResult(`Would push to ${remoteUrl}\n   ${localRef} -> ${remoteRef}\n`);
      }

      try {
        await this.git.push({
          dir: cwd,
          remote: remote,
          ref: options.deleteRef ? undefined : localRef,
          remoteRef: remoteRef,
          force: options.force,
          delete: options.deleteRef,
        } as Parameters<typeof this.git.push>[0]);

        // Set up upstream tracking if requested
        if (options.setUpstream && localRef) {
          try {
            await this.git.setConfig({
              dir: cwd,
              path: `branch.${localRef}.remote`,
              value: remote,
            });
            await this.git.setConfig({
              dir: cwd,
              path: `branch.${localRef}.merge`,
              value: `refs/heads/${remoteRef}`,
            });
          } catch {
            // Non-fatal
          }
        }

        if (options.deleteRef) {
          return createSuccessResult(`To ${remoteUrl}\n - [deleted]         ${remoteRef}\n`);
        }
        return createSuccessResult(`To ${remoteUrl}\n   ${localRef} -> ${remoteRef}\n`);

      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('authentication')) {
            return createErrorResult('fatal: Authentication failed. Please configure git credentials.');
          } else if (error.message.includes('rejected') || error.message.includes('Updates were rejected')) {
            return createErrorResult(`error: failed to push some refs to '${remoteUrl}'\nhint: ${error.message}`);
          } else if (error.message.includes('network')) {
            return createErrorResult('fatal: unable to access remote repository. Please check your network connection.');
          } else if (error.message.includes('Nostr signer is required')) {
            return createErrorResult('fatal: Nostr signer is required for pushing to Nostr repositories. Please log in with a Nostr account.');
          } else if (error.message.includes('Everything up-to-date')) {
            return createSuccessResult('Everything up-to-date\n');
          }
        }

        return createErrorResult(`Failed to push: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

    } catch (error) {
      return createErrorResult(`git push: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    remote: string;
    refspec?: string;
    options: PushOptions;
  } {
    const options: PushOptions = {
      force: false,
      setUpstream: false,
      tags: false,
      deleteRef: false,
      dryRun: false,
      all: false,
    };
    let remote = 'origin';
    let refspec: string | undefined;
    const positionalArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--force' || arg === '-f' || arg === '--force-with-lease') {
        options.force = true;
      } else if (arg === '--set-upstream' || arg === '-u') {
        options.setUpstream = true;
      } else if (arg === '--tags') {
        options.tags = true;
      } else if (arg === '--delete' || arg === '-d') {
        options.deleteRef = true;
      } else if (arg === '--dry-run' || arg === '-n') {
        options.dryRun = true;
      } else if (arg === '--all') {
        options.all = true;
      } else if (!arg.startsWith('-')) {
        positionalArgs.push(arg);
      }
    }

    if (positionalArgs.length >= 1) {
      remote = positionalArgs[0];
    }
    if (positionalArgs.length >= 2) {
      refspec = positionalArgs[1];
    }

    return { remote, refspec, options };
  }
}
