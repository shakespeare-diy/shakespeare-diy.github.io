import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitCommitCommand implements GitSubcommand {
  name = 'commit';
  description = 'Record changes to the repository';
  usage = 'git commit [-m <msg>] [-a | --all] [-am <msg>] [--amend] [--allow-empty] [--signoff] [-F <file>] [--author=<author>] [-C <commit>] [--no-verify]';

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

      const { options, message } = await this.parseArgs(args, cwd);

      if (!message && !options.amend && !options.reuseMessage) {
        return createErrorResult('Aborting commit due to empty commit message.');
      }

      // If -a flag is provided, stage all tracked files with modifications
      if (options.addAll) {
        await this.stageTrackedChanges(cwd);
      }

      // Get current status
      const statusMatrix = await this.git.statusMatrix({
        dir: cwd,
      });

      // Check for staged changes
      const stagedFiles = statusMatrix.filter(([, headStatus, , stageStatus]) => {
        return headStatus !== stageStatus;
      });

      if (stagedFiles.length === 0 && !options.allowEmpty && !options.amend) {
        return createErrorResult('nothing to commit, working tree clean');
      }

      let commitMessage = message;
      if (options.amend || options.reuseMessage) {
        // Get the last commit message if amending or reusing
        try {
          const logOpts: { dir: string; depth: number; ref?: string } = {
            dir: cwd,
            depth: 1,
          };
          if (options.reuseMessage) {
            logOpts.ref = options.reuseMessage;
          }
          const commits = await this.git.log(logOpts);
          if (commits.length > 0 && !message) {
            commitMessage = commits[0].commit.message;
          }
        } catch {
          // If we can't get the last commit, use the provided message or default
          if (!commitMessage) {
            commitMessage = 'Amended commit';
          }
        }
      }

      // Append sign-off if requested
      if (options.signoff && commitMessage) {
        const signoff = await this.buildSignoff(cwd, options.author);
        if (signoff && !commitMessage.includes(signoff)) {
          commitMessage = commitMessage.replace(/\n+$/, '') + `\n\nSigned-off-by: ${signoff}\n`;
        }
      }

      // Get current branch
      let currentBranch = 'main';
      try {
        currentBranch = await this.git.currentBranch({
          dir: cwd,
        }) || 'main';
      } catch {
        // Use default
      }

      // Create the commit
      const commitOptions: {
        dir: string;
        message: string;
        parent?: string[];
        author?: { name: string; email: string };
      } = {
        dir: cwd,
        message: commitMessage || 'Empty commit',
      };

      if (options.author) {
        const parsed = this.parseAuthor(options.author);
        if (parsed) {
          commitOptions.author = parsed;
        }
      }

      if (options.amend) {
        // For amend, we need to reset to the parent of the current commit
        try {
          const commits = await this.git.log({
            dir: cwd,
            depth: 2,
          });
          if (commits.length > 1) {
            commitOptions.parent = [commits[1].oid];
          }
        } catch {
          // If we can't get parent, proceed without amending
        }
      }

      const commitSha = await this.git.commit(commitOptions);

      // Get short hash
      const shortHash = commitSha.substring(0, 7);

      // Count changes (status matrix values: 0=absent, 1=unchanged from HEAD, 2=differs from HEAD)
      const addedFiles = stagedFiles.filter(([, headStatus, , stageStatus]) =>
        headStatus === 0 && stageStatus === 2
      ).length;

      const modifiedFiles = stagedFiles.filter(([, headStatus, , stageStatus]) =>
        headStatus === 1 && stageStatus === 2
      ).length;

      const deletedFiles = stagedFiles.filter(([, headStatus, , stageStatus]) =>
        headStatus === 1 && stageStatus === 0
      ).length;

      const totalFiles = stagedFiles.length;

      let result = `[${currentBranch} ${shortHash}] ${commitMessage}\n`;

      if (totalFiles > 0) {
        const changes: string[] = [];
        if (addedFiles > 0) changes.push(`${addedFiles} file${addedFiles !== 1 ? 's' : ''} added`);
        if (modifiedFiles > 0) changes.push(`${modifiedFiles} file${modifiedFiles !== 1 ? 's' : ''} changed`);
        if (deletedFiles > 0) changes.push(`${deletedFiles} file${deletedFiles !== 1 ? 's' : ''} deleted`);

        result += ` ${changes.join(', ')}\n`;
      }

      return createSuccessResult(result);

    } catch (error) {
      return createErrorResult(`git commit: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Stage all tracked files with modifications
   * This is used when the -a flag is provided
   */
  private async  stageTrackedChanges(cwd: string): Promise<void>  {
    try {
      // Get the status matrix
      const statusMatrix = await this.git.statusMatrix({
        dir: cwd,
      });

      // Process each file based on its status
      for (const [filepath, headStatus, workdirStatus] of statusMatrix) {
        // Only process tracked files (headStatus === 1) with changes
        if (headStatus === 1 && workdirStatus !== headStatus) {
          if (workdirStatus === 0) {
            // File was deleted, use remove
            await this.git.remove({
              dir: cwd,
              filepath,
            });
          } else {
            // File was modified, use add
            await this.git.add({
              dir: cwd,
              filepath,
            });
          }
        }
      }
    } catch (error) {
      throw new Error(`Failed to stage tracked changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async parseArgs(args: string[], cwd: string): Promise<{
    options: {
      amend: boolean;
      allowEmpty: boolean;
      addAll: boolean;
      signoff: boolean;
      noVerify: boolean;
      author?: string;
      reuseMessage?: string;
    };
    message?: string;
  }> {
    const options: {
      amend: boolean;
      allowEmpty: boolean;
      addAll: boolean;
      signoff: boolean;
      noVerify: boolean;
      author?: string;
      reuseMessage?: string;
    } = {
      amend: false,
      allowEmpty: false,
      addAll: false,
      signoff: false,
      noVerify: false,
    };
    const messageParts: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '-m' || arg === '--message') {
        if (i + 1 < args.length) {
          messageParts.push(args[i + 1]);
          i++; // Skip next argument as it's the message
        }
      } else if (arg.startsWith('-m=')) {
        messageParts.push(arg.substring(3));
      } else if (arg.startsWith('--message=')) {
        messageParts.push(arg.substring(10));
      } else if (arg === '-F' || arg === '--file') {
        if (i + 1 < args.length) {
          const filePath = args[i + 1];
          try {
            const content = await this.fs.readFile(
              filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`,
              'utf8'
            );
            messageParts.push(content.replace(/\n+$/, ''));
          } catch {
            // Ignore if file can't be read
          }
          i++;
        }
      } else if (arg.startsWith('--file=')) {
        const filePath = arg.substring(7);
        try {
          const content = await this.fs.readFile(
            filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`,
            'utf8'
          );
          messageParts.push(content.replace(/\n+$/, ''));
        } catch {
          // Ignore
        }
      } else if (arg === '--amend') {
        options.amend = true;
      } else if (arg === '--allow-empty') {
        options.allowEmpty = true;
      } else if (arg === '-a' || arg === '--all') {
        options.addAll = true;
      } else if (arg === '-am' || arg === '-ma') {
        options.addAll = true;
        if (i + 1 < args.length) {
          messageParts.push(args[i + 1]);
          i++;
        }
      } else if (arg === '-s' || arg === '--signoff') {
        options.signoff = true;
      } else if (arg === '--no-verify' || arg === '-n') {
        // --no-verify skips pre-commit / commit-msg hooks; we don't run hooks anyway
        options.noVerify = true;
      } else if (arg === '--author') {
        if (i + 1 < args.length) {
          options.author = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--author=')) {
        options.author = arg.substring(9);
      } else if (arg === '-C' || arg === '--reuse-message') {
        if (i + 1 < args.length) {
          options.reuseMessage = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--reuse-message=')) {
        options.reuseMessage = arg.substring(16);
      }
    }

    // Multiple -m flags are joined with double newlines (standard git behavior)
    const message = messageParts.length > 0 ? messageParts.join('\n\n') : undefined;

    return { options, message };
  }

  /**
   * Parse an author string like "Name <email@example.com>"
   */
  private parseAuthor(author: string): { name: string; email: string } | null {
    const match = author.match(/^(.+?)\s*<(.+?)>\s*$/);
    if (match) {
      return { name: match[1].trim(), email: match[2].trim() };
    }
    return null;
  }

  /**
   * Build a Signed-off-by line from the current user config or the provided author
   */
  private async buildSignoff(cwd: string, authorOverride?: string): Promise<string | null> {
    if (authorOverride) {
      const parsed = this.parseAuthor(authorOverride);
      if (parsed) {
        return `${parsed.name} <${parsed.email}>`;
      }
    }
    try {
      const name = await this.git.getConfig({ dir: cwd, path: 'user.name' });
      const email = await this.git.getConfig({ dir: cwd, path: 'user.email' });
      if (name && email) {
        return `${name} <${email}>`;
      }
    } catch {
      // Ignore
    }
    return null;
  }
}
