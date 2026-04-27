// http is handled by the Git class
import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitCloneCommand implements GitSubcommand {
  name = 'clone';
  description = 'Clone a repository into a new directory';
  usage = 'git clone [--depth <depth>] [--single-branch] [--branch | -b <name>] [--origin | -o <name>] [--bare] <repository> [<directory>]';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      const { options, repository, directory } = this.parseArgs(args);

      if (!repository) {
        return createErrorResult('fatal: You must specify a repository to clone.');
      }

      // Determine the target directory
      let targetDir = directory;
      if (!targetDir) {
        // Extract repository name from URL
        const urlParts = repository.split('/');
        const repoName = urlParts[urlParts.length - 1];
        targetDir = repoName.replace(/\.git$/, ''); // Remove .git suffix if present
      }

      const targetPath = targetDir.startsWith('/') ? targetDir : `${cwd}/${targetDir}`;

      // Check if target directory already exists
      try {
        await this.fs.stat(targetPath);
        return createErrorResult(`fatal: destination path '${targetDir}' already exists and is not an empty directory.`);
      } catch {
        // Directory doesn't exist, which is what we want
      }

      // Validate URL format (accept nostr:// as well)
      if (!repository.startsWith('nostr://')) {
        try {
          new URL(repository);
        } catch {
          return createErrorResult(`fatal: repository '${repository}' does not appear to be a git repository`);
        }
      }

      // Clone the repository
      await this.git.clone({
        dir: targetPath,
        url: repository,
        singleBranch: options.singleBranch,
        depth: options.depth,
        ref: options.branch,
        remote: options.origin,
        noCheckout: options.bare,
      } as Parameters<typeof this.git.clone>[0]);

      return createSuccessResult(`Cloning into '${targetDir}'...\ndone.\n`);

    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('authentication')) {
          return createErrorResult('fatal: Authentication failed. Repository may be private or credentials are required.');
        } else if (error.message.includes('network')) {
          return createErrorResult('fatal: unable to access repository. Please check your network connection.');
        } else if (error.message.includes('not found')) {
          return createErrorResult('fatal: repository not found.');
        }
      }

      return createErrorResult(`git clone: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    options: {
      depth?: number;
      singleBranch: boolean;
      branch?: string;
      origin: string;
      bare: boolean;
    };
    repository?: string;
    directory?: string;
  } {
    const options: {
      depth?: number;
      singleBranch: boolean;
      branch?: string;
      origin: string;
      bare: boolean;
    } = {
      singleBranch: false,
      origin: 'origin',
      bare: false,
    };
    let repository: string | undefined;
    let directory: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--depth') {
        if (i + 1 < args.length) {
          const depth = parseInt(args[i + 1], 10);
          if (!isNaN(depth) && depth > 0) {
            options.depth = depth;
          }
          i++;
        }
      } else if (arg.startsWith('--depth=')) {
        const depth = parseInt(arg.substring(8), 10);
        if (!isNaN(depth) && depth > 0) {
          options.depth = depth;
        }
      } else if (arg === '--single-branch') {
        options.singleBranch = true;
      } else if (arg === '--no-single-branch') {
        options.singleBranch = false;
      } else if (arg === '--branch' || arg === '-b') {
        if (i + 1 < args.length) {
          options.branch = args[i + 1];
          options.singleBranch = true;
          i++;
        }
      } else if (arg.startsWith('--branch=')) {
        options.branch = arg.substring(9);
        options.singleBranch = true;
      } else if (arg === '--origin' || arg === '-o') {
        if (i + 1 < args.length) {
          options.origin = args[i + 1];
          i++;
        }
      } else if (arg.startsWith('--origin=')) {
        options.origin = arg.substring(9);
      } else if (arg === '--bare' || arg === '--mirror') {
        options.bare = true;
      } else if (!arg.startsWith('-')) {
        if (!repository) {
          repository = arg;
        } else if (!directory) {
          directory = arg;
        }
      }
    }

    return { options, repository, directory };
  }
}
