import { join, basename } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'rm' command.
 *
 * Supported options:
 *   -r, -R, --recursive  Remove directories and their contents recursively
 *   -f, --force          Ignore nonexistent files and suppress prompts
 *   -d, --dir            Remove empty directories
 *   -v, --verbose        Explain what is being done
 *   -i                   Prompt before every removal (no-op in non-interactive)
 *   --                   End of options
 */
export class RmCommand implements ShellCommand {
  name = 'rm';
  description = 'Remove files and directories';
  usage = 'rm [-rRfdvi] [--] file...';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['r', 'R', 'f', 'd', 'v', 'i'],
      booleanLong: ['recursive', 'force', 'dir', 'verbose'],
      longToShort: {
        recursive: 'r',
        force: 'f',
        dir: 'd',
        verbose: 'v',
      },
      shortAliases: { R: 'r' },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      recursive: parsed.flags.has('r'),
      force: parsed.flags.has('f'),
      allowEmptyDir: parsed.flags.has('d'),
      verbose: parsed.flags.has('v'),
    };

    const paths = parsed.operands;
    if (paths.length === 0) {
      if (opts.force) return createSuccessResult('');
      return createErrorResult(`${this.name}: missing operand\nUsage: ${this.usage}`);
    }

    const verboseOut: string[] = [];
    const errors: string[] = [];

    for (const path of paths) {
      // Refuse to remove . or ..
      const b = basename(path);
      if (b === '.' || b === '..') {
        if (!opts.force) {
          errors.push(`${this.name}: refusing to remove '.' or '..' directory: skipping '${path}'`);
        }
        continue;
      }

      try {
        validateWritePath(path, this.name, cwd);
      } catch (error) {
        if (!opts.force) {
          errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
        continue;
      }

      const absolutePath = resolvePath(path, cwd);

      try {
        const stats = await this.fs.stat(absolutePath);

        if (stats.isDirectory()) {
          if (opts.recursive) {
            await this.removeDirectoryRecursive(absolutePath, verboseOut, opts.verbose);
            if (opts.verbose) verboseOut.push(`removed directory '${path}'`);
          } else if (opts.allowEmptyDir) {
            await this.fs.rmdir(absolutePath);
            if (opts.verbose) verboseOut.push(`removed directory '${path}'`);
          } else {
            if (!opts.force) {
              errors.push(`${this.name}: cannot remove '${path}': Is a directory`);
            }
          }
        } else {
          await this.fs.unlink(absolutePath);
          if (opts.verbose) verboseOut.push(`removed '${path}'`);
        }
      } catch (error) {
        if (opts.force) continue;
        const { kind, message } = classifyFsError(error);
        if (kind === 'ENOENT') {
          errors.push(`${this.name}: cannot remove '${path}': No such file or directory`);
        } else if (kind === 'EACCES') {
          errors.push(`${this.name}: cannot remove '${path}': Permission denied`);
        } else {
          errors.push(`${this.name}: cannot remove '${path}': ${message}`);
        }
      }
    }

    if (errors.length > 0) {
      const stdout = verboseOut.length > 0 ? verboseOut.join('\n') + '\n' : '';
      return {
        exitCode: 1,
        stdout,
        stderr: errors.join('\n'),
      };
    }

    return createSuccessResult(verboseOut.length > 0 ? verboseOut.join('\n') + '\n' : '');
  }

  private async removeDirectoryRecursive(dirPath: string, verboseOut: string[], verbose: boolean): Promise<void> {
    const entries = await this.fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.removeDirectoryRecursive(entryPath, verboseOut, verbose);
      } else {
        await this.fs.unlink(entryPath);
        if (verbose) verboseOut.push(`removed '${entryPath}'`);
      }
    }
    await this.fs.rmdir(dirPath);
  }
}
