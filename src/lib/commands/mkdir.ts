import { dirname } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'mkdir' command.
 *
 * Supported options:
 *   -p, --parents   Create parent directories as needed; no error if existing
 *   -v, --verbose   Print a message for each created directory
 *   -m, --mode      Set file mode (accepted but ignored — VFS has no mode)
 *   --              End of options
 */
export class MkdirCommand implements ShellCommand {
  name = 'mkdir';
  description = 'Create directories';
  usage = 'mkdir [-pv] [-m mode] [--] directory...';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['p', 'v'],
      valueShort: ['m'],
      booleanLong: ['parents', 'verbose'],
      valueLong: ['mode'],
      longToShort: { parents: 'p', verbose: 'v', mode: 'm' },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      parents: parsed.flags.has('p'),
      verbose: parsed.flags.has('v'),
    };

    const directories = parsed.operands;
    if (directories.length === 0) {
      return createErrorResult(`${this.name}: missing operand\nUsage: ${this.usage}`);
    }

    const verboseOut: string[] = [];

    for (const dirPath of directories) {
      try {
        validateWritePath(dirPath, this.name, cwd);
      } catch (error) {
        return createErrorResult(error instanceof Error ? error.message : 'Unknown error');
      }

      const absolutePath = resolvePath(dirPath, cwd);

      if (opts.parents) {
        try {
          await this.createRecursive(absolutePath, verboseOut, opts.verbose);
        } catch (error) {
          const { message } = classifyFsError(error);
          return createErrorResult(`${this.name}: cannot create directory '${dirPath}': ${message}`);
        }
        continue;
      }

      // Without -p: error if exists or parent missing.
      try {
        await this.fs.stat(absolutePath);
        return createErrorResult(`${this.name}: cannot create directory '${dirPath}': File exists`);
      } catch (error) {
        const { kind } = classifyFsError(error);
        if (kind !== 'ENOENT') {
          return createErrorResult(`${this.name}: ${dirPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      const parentDir = dirname(absolutePath);
      try {
        const parentStats = await this.fs.stat(parentDir);
        if (!parentStats.isDirectory()) {
          return createErrorResult(`${this.name}: cannot create directory '${dirPath}': Not a directory`);
        }
      } catch {
        return createErrorResult(`${this.name}: cannot create directory '${dirPath}': No such file or directory`);
      }

      try {
        await this.fs.mkdir(absolutePath);
        if (opts.verbose) verboseOut.push(`${this.name}: created directory '${dirPath}'`);
      } catch (error) {
        const { message } = classifyFsError(error);
        return createErrorResult(`${this.name}: cannot create directory '${dirPath}': ${message}`);
      }
    }

    return createSuccessResult(verboseOut.length > 0 ? verboseOut.join('\n') + '\n' : '');
  }

  private async createRecursive(absolutePath: string, verboseOut: string[], verbose: boolean): Promise<void> {
    try {
      const stats = await this.fs.stat(absolutePath);
      if (stats.isDirectory()) return;
      throw new Error(`File exists`);
    } catch (error) {
      const { kind } = classifyFsError(error);
      if (kind !== 'ENOENT') throw error;
    }

    const parent = dirname(absolutePath);
    if (parent !== absolutePath && parent !== '') {
      await this.createRecursive(parent, verboseOut, verbose);
    }

    try {
      await this.fs.mkdir(absolutePath);
      if (verbose) verboseOut.push(`${this.name}: created directory '${absolutePath}'`);
    } catch (error) {
      const { kind } = classifyFsError(error);
      // EEXIST is fine under -p (race).
      if (kind !== 'EEXIST') throw error;
    }
  }
}
