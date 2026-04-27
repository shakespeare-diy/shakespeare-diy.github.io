import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

type RemoteAction = 'list' | 'add' | 'remove' | 'set-url' | 'get-url' | 'rename' | 'show';

export class GitRemoteCommand implements GitSubcommand {
  name = 'remote';
  description = 'Manage set of tracked repositories';
  usage = 'git remote [-v] | git remote add <name> <url> | git remote remove <name> | git remote set-url <name> <url> | git remote get-url <name> | git remote rename <old> <new> | git remote show <name>';

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

      const { action, name, url, newName, options } = this.parseArgs(args);

      switch (action) {
        case 'list':
          return await this.listRemotes(options.verbose, cwd);
        case 'add':
          return await this.addRemote(name!, url!, cwd);
        case 'remove':
          return await this.removeRemote(name!, cwd);
        case 'set-url':
          return await this.setRemoteUrl(name!, url!, cwd);
        case 'get-url':
          return await this.getRemoteUrl(name!, cwd);
        case 'rename':
          return await this.renameRemote(name!, newName!, cwd);
        case 'show':
          return await this.showRemote(name!, cwd);
        default:
          return await this.listRemotes(options.verbose, cwd);
      }

    } catch (error) {
      return createErrorResult(`git remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    action: RemoteAction;
    name?: string;
    url?: string;
    newName?: string;
    options: { verbose: boolean };
  } {
    const options = { verbose: false };
    let action: RemoteAction = 'list';
    let name: string | undefined;
    let url: string | undefined;
    let newName: string | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '-v' || arg === '--verbose') {
        options.verbose = true;
      } else if (arg === 'add') {
        action = 'add';
        if (i + 1 < args.length) { name = args[i + 1]; i++; }
        if (i + 1 < args.length) { url = args[i + 1]; i++; }
      } else if (arg === 'remove' || arg === 'rm') {
        action = 'remove';
        if (i + 1 < args.length) { name = args[i + 1]; i++; }
      } else if (arg === 'set-url') {
        action = 'set-url';
        if (i + 1 < args.length) { name = args[i + 1]; i++; }
        if (i + 1 < args.length) { url = args[i + 1]; i++; }
      } else if (arg === 'get-url') {
        action = 'get-url';
        if (i + 1 < args.length) { name = args[i + 1]; i++; }
      } else if (arg === 'rename') {
        action = 'rename';
        if (i + 1 < args.length) { name = args[i + 1]; i++; }
        if (i + 1 < args.length) { newName = args[i + 1]; i++; }
      } else if (arg === 'show') {
        action = 'show';
        if (i + 1 < args.length) { name = args[i + 1]; i++; }
      }
    }

    return { action, name, url, newName, options };
  }

  private async listRemotes(verbose: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      const remotes = await this.git.listRemotes({ dir: cwd });

      if (remotes.length === 0) {
        return createSuccessResult('');
      }

      const lines: string[] = [];

      if (verbose) {
        for (const remote of remotes) {
          lines.push(`${remote.remote}\t${remote.url} (fetch)`);
          lines.push(`${remote.remote}\t${remote.url} (push)`);
        }
      } else {
        for (const remote of remotes) {
          lines.push(remote.remote);
        }
      }

      return createSuccessResult(lines.join('\n') + (lines.length > 0 ? '\n' : ''));

    } catch (error) {
      return createErrorResult(`Failed to list remotes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async addRemote(name: string, url: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!name || !url) {
        return createErrorResult('usage: git remote add <name> <url>');
      }

      try {
        const remotes = await this.git.listRemotes({ dir: cwd });
        if (remotes.find(r => r.remote === name)) {
          return createErrorResult(`fatal: remote ${name} already exists.`);
        }
      } catch {
        // Continue
      }

      await this.git.addRemote({ dir: cwd, remote: name, url });

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to add remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async removeRemote(name: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!name) {
        return createErrorResult('usage: git remote remove <name>');
      }

      try {
        const remotes = await this.git.listRemotes({ dir: cwd });
        if (!remotes.find(r => r.remote === name)) {
          return createErrorResult(`fatal: No such remote: ${name}`);
        }
      } catch {
        return createErrorResult(`fatal: No such remote: ${name}`);
      }

      await this.git.deleteRemote({ dir: cwd, remote: name });

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to remove remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async setRemoteUrl(name: string, url: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!name || !url) {
        return createErrorResult('usage: git remote set-url <name> <url>');
      }

      try {
        const remotes = await this.git.listRemotes({ dir: cwd });
        if (!remotes.find(r => r.remote === name)) {
          return createErrorResult(`fatal: No such remote '${name}'`);
        }
      } catch {
        return createErrorResult(`fatal: No such remote '${name}'`);
      }

      // setRemoteURL is implemented in the Git wrapper
      await this.git.setRemoteURL({ dir: cwd, remote: name, url });

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to set remote URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getRemoteUrl(name: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!name) {
        return createErrorResult('usage: git remote get-url <name>');
      }

      const url = await this.git.getRemoteURL(cwd, name);
      if (!url) {
        return createErrorResult(`fatal: No such remote '${name}'`);
      }

      return createSuccessResult(url + '\n');

    } catch (error) {
      return createErrorResult(`Failed to get remote URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async renameRemote(oldName: string, newName: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!oldName || !newName) {
        return createErrorResult('usage: git remote rename <old> <new>');
      }

      const remotes = await this.git.listRemotes({ dir: cwd });
      const oldRemote = remotes.find(r => r.remote === oldName);
      if (!oldRemote) {
        return createErrorResult(`fatal: No such remote '${oldName}'`);
      }
      if (remotes.find(r => r.remote === newName)) {
        return createErrorResult(`fatal: remote ${newName} already exists.`);
      }

      // isomorphic-git has no rename: delete + re-add
      await this.git.deleteRemote({ dir: cwd, remote: oldName });
      await this.git.addRemote({ dir: cwd, remote: newName, url: oldRemote.url });

      return createSuccessResult('');
    } catch (error) {
      return createErrorResult(`Failed to rename remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async showRemote(name: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!name) {
        return createErrorResult('usage: git remote show <name>');
      }

      const remotes = await this.git.listRemotes({ dir: cwd });
      const remote = remotes.find(r => r.remote === name);
      if (!remote) {
        return createErrorResult(`fatal: No such remote '${name}'`);
      }

      const lines: string[] = [];
      lines.push(`* remote ${name}`);
      lines.push(`  Fetch URL: ${remote.url}`);
      lines.push(`  Push  URL: ${remote.url}`);

      return createSuccessResult(lines.join('\n') + '\n');
    } catch (error) {
      return createErrorResult(`Failed to show remote: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
