import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

/**
 * `git revert`: creates a new commit that undoes the changes from a previous commit.
 * NOTE: This is a simplified implementation. True git revert creates an inverse
 * patch; this version stages an inverse tree and commits it.
 */
export class GitRevertCommand implements GitSubcommand {
  name = 'revert';
  description = 'Revert some existing commits';
  usage = 'git revert [--no-edit] [--no-commit | -n] <commit>';

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

      const { commit, options } = this.parseArgs(args);

      if (!commit) {
        return createErrorResult('fatal: empty commit set passed');
      }

      // Resolve target commit
      let targetOid: string;
      try {
        targetOid = await this.git.resolveRef({ dir: cwd, ref: commit });
      } catch {
        return createErrorResult(`fatal: bad revision '${commit}'`);
      }

      // Read the commit and its parent
      let targetCommit: Awaited<ReturnType<Git['readCommit']>>;
      try {
        targetCommit = await this.git.readCommit({ dir: cwd, oid: targetOid });
      } catch {
        return createErrorResult(`fatal: bad revision '${commit}'`);
      }

      const parentOid = targetCommit.commit.parent?.[0];
      if (!parentOid) {
        return createErrorResult(`fatal: ${targetOid.substring(0, 7)} is a root commit, cannot revert`);
      }

      // Walk both trees to get the inverse changes
      const targetFiles = await this.getFileOids(targetOid, cwd);
      const parentFiles = await this.getFileOids(parentOid, cwd);

      const changes: Array<{ path: string; action: 'restore' | 'delete' }> = [];

      // Files that existed in parent but were removed/modified in target: restore from parent
      for (const [path, parentFileOid] of parentFiles) {
        const targetFileOid = targetFiles.get(path);
        if (!targetFileOid || targetFileOid !== parentFileOid) {
          changes.push({ path, action: 'restore' });
        }
        void parentFileOid;
      }
      // Files added in target: delete
      for (const path of targetFiles.keys()) {
        if (!parentFiles.has(path)) {
          changes.push({ path, action: 'delete' });
        }
      }

      // Apply the changes
      for (const change of changes) {
        try {
          if (change.action === 'restore') {
            const blob = await this.git.readBlob({ dir: cwd, oid: parentOid, filepath: change.path });
            // Ensure directory exists
            const dir = change.path.substring(0, change.path.lastIndexOf('/'));
            if (dir) {
              try {
                await this.fs.mkdir(`${cwd}/${dir}`, { recursive: true });
              } catch { /* empty */ }
            }
            await this.fs.writeFile(`${cwd}/${change.path}`, new TextDecoder().decode(blob.blob));
            await this.git.add({ dir: cwd, filepath: change.path });
          } else {
            try {
              await this.fs.unlink(`${cwd}/${change.path}`);
            } catch { /* empty */ }
            await this.git.remove({ dir: cwd, filepath: change.path });
          }
        } catch (error) {
          return createErrorResult(`error: failed to revert ${change.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      if (options.noCommit) {
        return createSuccessResult(`Applied revert for commit ${targetOid.substring(0, 7)}\n`);
      }

      // Create the revert commit
      const message = `Revert "${targetCommit.commit.message.split('\n')[0]}"\n\nThis reverts commit ${targetOid}.\n`;

      try {
        const newCommitOid = await this.git.commit({
          dir: cwd,
          message,
        });
        return createSuccessResult(`[${await this.currentBranchName(cwd)} ${newCommitOid.substring(0, 7)}] ${message.split('\n')[0]}\n`);
      } catch (error) {
        return createErrorResult(`Failed to create revert commit: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } catch (error) {
      return createErrorResult(`git revert: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async currentBranchName(cwd: string): Promise<string> {
    try {
      return await this.git.currentBranch({ dir: cwd }) || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  private async getFileOids(commitOid: string, cwd: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      try {
        const tree = await this.git.readTree({ dir: cwd, oid: treeOid });
        for (const entry of tree.tree as Array<{ mode: string; path: string; oid: string; type?: string }>) {
          const path = prefix ? `${prefix}/${entry.path}` : entry.path;
          if (entry.mode === '040000' || entry.type === 'tree') {
            await walk(entry.oid, path);
          } else {
            files.set(path, entry.oid);
          }
        }
      } catch { /* empty */ }
    };
    await walk(commitOid, '');
    return files;
  }

  private parseArgs(args: string[]): {
    commit?: string;
    options: { noEdit: boolean; noCommit: boolean };
  } {
    const options = { noEdit: false, noCommit: false };
    let commit: string | undefined;

    for (const arg of args) {
      if (arg === '--no-edit') {
        options.noEdit = true;
      } else if (arg === '--no-commit' || arg === '-n') {
        options.noCommit = true;
      } else if (!arg.startsWith('-')) {
        commit = arg;
      }
    }

    return { commit, options };
  }
}
