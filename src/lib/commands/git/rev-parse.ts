import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitRevParseCommand implements GitSubcommand {
  name = 'rev-parse';
  description = 'Pick out and massage parameters';
  usage = 'git rev-parse [--short[=<length>]] [--abbrev-ref] [--show-toplevel] [--git-dir] [--is-inside-work-tree] <ref>...';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      const { refs, options } = this.parseArgs(args);

      // Check if we're in a git repository
      let inRepo = true;
      try {
        await this.fs.stat(`${cwd}/.git`);
      } catch {
        inRepo = false;
      }

      // Handle special flags
      const outputs: string[] = [];

      if (options.showToplevel) {
        if (!inRepo) {
          return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
        }
        outputs.push(cwd);
      }

      if (options.gitDir) {
        if (!inRepo) {
          return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
        }
        outputs.push(`${cwd}/.git`);
      }

      if (options.isInsideWorkTree) {
        outputs.push(inRepo ? 'true' : 'false');
      }

      if (options.isInsideGitDir) {
        outputs.push('false');
      }

      if (options.isBareRepository) {
        outputs.push('false');
      }

      // Process refs
      for (const ref of refs) {
        if (!inRepo) {
          return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
        }
        try {
          if (options.abbrevRef) {
            // Output the branch name (remove refs/heads/ prefix)
            if (ref === 'HEAD') {
              const branch = await this.git.currentBranch({ dir: cwd });
              outputs.push(branch || 'HEAD');
            } else {
              outputs.push(ref);
            }
          } else {
            const oid = await this.resolveAnyRef(ref, cwd);
            if (options.short) {
              const len = options.short === true ? 7 : options.short;
              outputs.push(oid.substring(0, len));
            } else {
              outputs.push(oid);
            }
          }
        } catch {
          return createErrorResult(`fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`);
        }
      }

      if (outputs.length === 0) {
        return createErrorResult('usage: git rev-parse [--short[=<length>]] [--abbrev-ref] [--show-toplevel] [--git-dir] <ref>...');
      }

      return createSuccessResult(outputs.join('\n') + '\n');
    } catch (error) {
      return createErrorResult(`git rev-parse: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Resolve a ref including HEAD~N, HEAD^N, branch names, or commit hashes.
   */
  private async resolveAnyRef(ref: string, cwd: string): Promise<string> {
    // HEAD~N syntax
    const tildeMatch = ref.match(/^(.+)~(\d+)$/);
    if (tildeMatch) {
      const [, baseRef, steps] = tildeMatch;
      let currentOid = await this.resolveAnyRef(baseRef, cwd);
      const numSteps = parseInt(steps, 10);
      for (let i = 0; i < numSteps; i++) {
        const commit = await this.git.readCommit({ dir: cwd, oid: currentOid });
        if (!commit.commit.parent || commit.commit.parent.length === 0) {
          throw new Error('No parent');
        }
        currentOid = commit.commit.parent[0];
      }
      return currentOid;
    }

    // HEAD^N syntax
    const caretMatch = ref.match(/^(.+)\^(\d*)$/);
    if (caretMatch) {
      const [, baseRef, parentNum] = caretMatch;
      const parentIndex = parentNum ? parseInt(parentNum, 10) - 1 : 0;
      const baseOid = await this.resolveAnyRef(baseRef, cwd);
      const commit = await this.git.readCommit({ dir: cwd, oid: baseOid });
      if (!commit.commit.parent || parentIndex >= commit.commit.parent.length) {
        throw new Error('No parent');
      }
      return commit.commit.parent[parentIndex];
    }

    return await this.git.resolveRef({ dir: cwd, ref });
  }

  private parseArgs(args: string[]): {
    refs: string[];
    options: {
      short: boolean | number;
      abbrevRef: boolean;
      showToplevel: boolean;
      gitDir: boolean;
      isInsideWorkTree: boolean;
      isInsideGitDir: boolean;
      isBareRepository: boolean;
    };
  } {
    const options = {
      short: false as boolean | number,
      abbrevRef: false,
      showToplevel: false,
      gitDir: false,
      isInsideWorkTree: false,
      isInsideGitDir: false,
      isBareRepository: false,
    };
    const refs: string[] = [];

    for (const arg of args) {
      if (arg === '--short') {
        options.short = true;
      } else if (arg.startsWith('--short=')) {
        options.short = parseInt(arg.substring(8), 10) || 7;
      } else if (arg === '--abbrev-ref') {
        options.abbrevRef = true;
      } else if (arg === '--show-toplevel') {
        options.showToplevel = true;
      } else if (arg === '--git-dir') {
        options.gitDir = true;
      } else if (arg === '--is-inside-work-tree') {
        options.isInsideWorkTree = true;
      } else if (arg === '--is-inside-git-dir') {
        options.isInsideGitDir = true;
      } else if (arg === '--is-bare-repository') {
        options.isBareRepository = true;
      } else if (!arg.startsWith('-')) {
        refs.push(arg);
      }
    }

    return { refs, options };
  }
}
