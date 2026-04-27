import { join, resolve, dirname } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { isAbsolutePath } from "../security";
import { parseOptions } from "./utils";

/**
 * Implementation of the 'cd' command.
 *
 * Supported options:
 *   -L   Follow symbolic links (default; no-op in our VFS)
 *   -P   Use the physical directory, without symlinks (no-op in our VFS)
 *
 * Supported forms:
 *   cd             → $HOME (defaults to '/' when unset)
 *   cd -           → previous directory (OLDPWD)
 *   cd ~           → $HOME
 *   cd ~/foo       → $HOME/foo
 *   cd ..          → parent
 *   cd /abs/path   → absolute
 *   cd rel/path    → relative to CWD
 */
export class CdCommand implements ShellCommand {
  name = 'cd';
  description = 'Change directory';
  usage = 'cd [-LP] [directory | -]';

  private fs: JSRuntimeFS;
  /** Tracked previous working directory for `cd -`. */
  private oldPwd: string | undefined;
  /** Default home dir when HOME env var is not available. */
  private homeDir = '/';

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  /** Optional hook used by the executor to supply HOME. */
  setHomeDir(home: string): void {
    this.homeDir = home;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['L', 'P'],
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    if (parsed.operands.length > 1) {
      return createErrorResult(`${this.name}: too many arguments`);
    }

    let targetPath: string;

    if (parsed.operands.length === 0) {
      // cd with no args → $HOME
      targetPath = this.homeDir;
    } else {
      targetPath = parsed.operands[0];
    }

    // Handle `cd -`
    if (targetPath === '-') {
      if (!this.oldPwd) {
        return createErrorResult(`${this.name}: OLDPWD not set`);
      }
      const previous = this.oldPwd;
      // POSIX: cd - prints the new directory and then chdir's to it.
      const check = await this.checkDir(previous);
      if (check) return check;
      this.oldPwd = cwd;
      return createSuccessResult(previous + '\n', previous);
    }

    // Tilde expansion (tokenizer normally handles this, but handle leftovers).
    if (targetPath === '~' || targetPath.startsWith('~/')) {
      targetPath = this.homeDir + targetPath.slice(1);
    }

    let newCwd: string;
    if (isAbsolutePath(targetPath)) {
      newCwd = targetPath;
    } else if (targetPath === '.') {
      newCwd = cwd;
    } else if (targetPath === '..') {
      const parentPath = dirname(cwd);
      newCwd = parentPath || '/';
    } else {
      newCwd = join(cwd, targetPath);
    }

    newCwd = resolve(newCwd);

    const err = await this.checkDir(newCwd, targetPath);
    if (err) return err;

    this.oldPwd = cwd;
    return createSuccessResult('', newCwd);
  }

  private async checkDir(path: string, display?: string): Promise<ShellCommandResult | null> {
    const label = display ?? path;
    try {
      const stats = await this.fs.stat(path);
      if (!stats.isDirectory()) {
        return createErrorResult(`${this.name}: ${label}: Not a directory`);
      }
      return null;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ENOENT') || error.message.includes('not found')) {
          return createErrorResult(`${this.name}: ${label}: No such file or directory`);
        }
        if (error.message.includes('EACCES') || error.message.includes('permission')) {
          return createErrorResult(`${this.name}: ${label}: Permission denied`);
        }
        return createErrorResult(`${this.name}: ${label}: ${error.message}`);
      }
      return createErrorResult(`${this.name}: ${label}: Unknown error`);
    }
  }
}
