import { join, dirname, basename } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'mv' command.
 *
 * Moves/renames files or directories. By default, existing destinations
 * are overwritten (POSIX-compliant).
 *
 * Supported options:
 *   -f, --force           Force overwrite (default behavior; here mostly to silence -i)
 *   -i, --interactive     Prompt before overwrite (no-op: treat as silent overwrite)
 *   -n, --no-clobber      Do not overwrite an existing file
 *   -v, --verbose         Explain what is being done
 *   -T, --no-target-directory  Treat destination as a regular file
 *   --                    End of options
 */
export class MvCommand implements ShellCommand {
  name = 'mv';
  description = 'Move/rename files and directories';
  usage = 'mv [-finvT] [--] source... destination';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['f', 'i', 'n', 'v', 'T'],
      booleanLong: ['force', 'interactive', 'no-clobber', 'verbose', 'no-target-directory'],
      longToShort: {
        force: 'f',
        interactive: 'i',
        'no-clobber': 'n',
        verbose: 'v',
        'no-target-directory': 'T',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      noClobber: parsed.flags.has('n'),
      verbose: parsed.flags.has('v'),
      noTargetDir: parsed.flags.has('T'),
    };

    const paths = parsed.operands;
    if (paths.length < 2) {
      return createErrorResult(`${this.name}: missing file operand\nUsage: ${this.usage}`);
    }

    const sources = paths.slice(0, -1);
    const destination = paths[paths.length - 1];

    const pathsToValidate = [destination, ...sources];
    for (const path of pathsToValidate) {
      try {
        validateWritePath(path, this.name, cwd);
      } catch (error) {
        return createErrorResult(error instanceof Error ? error.message : 'Unknown error');
      }
    }

    const destAbsolutePath = resolvePath(destination, cwd);

    let destIsDir = false;
    try {
      const destStats = await this.fs.stat(destAbsolutePath);
      destIsDir = destStats.isDirectory();
    } catch {
      // Destination doesn't exist.
    }
    if (opts.noTargetDir) destIsDir = false;

    if (sources.length > 1 && !destIsDir) {
      return createErrorResult(`${this.name}: target '${destination}' is not a directory`);
    }

    const verboseOut: string[] = [];

    for (const source of sources) {
      try {
        const sourceAbsolutePath = resolvePath(source, cwd);
        await this.fs.stat(sourceAbsolutePath);

        const targetPath = destIsDir
          ? join(destAbsolutePath, basename(source))
          : destAbsolutePath;

        // Existence / no-clobber check.
        let targetExists = false;
        try {
          await this.fs.stat(targetPath);
          targetExists = true;
        } catch {
          // Doesn't exist.
        }

        if (targetExists && opts.noClobber) {
          continue;
        }

        // Ensure parent dir exists (POSIX mv errors here; we keep legacy permissive).
        const targetDir = dirname(targetPath);
        try {
          await this.fs.stat(targetDir);
        } catch {
          await this.fs.mkdir(targetDir, { recursive: true });
        }

        if (targetExists) {
          // Remove existing target so rename succeeds (some VFSes don't
          // support atomic rename-over-existing).
          try {
            const ts = await this.fs.stat(targetPath);
            if (ts.isDirectory()) {
              await this.fs.rmdir(targetPath);
            } else {
              await this.fs.unlink(targetPath);
            }
          } catch {
            // Best-effort; the rename may still work.
          }
        }

        await this.fs.rename(sourceAbsolutePath, targetPath);
        if (opts.verbose) verboseOut.push(`renamed '${source}' -> '${targetPath}'`);
      } catch (error) {
        const { kind, message } = classifyFsError(error);
        if (kind === 'ENOENT') {
          return createErrorResult(`${this.name}: cannot stat '${source}': No such file or directory`);
        }
        if (kind === 'EACCES') {
          return createErrorResult(`${this.name}: cannot move '${source}': Permission denied`);
        }
        return createErrorResult(`${this.name}: cannot move '${source}': ${message}`);
      }
    }

    return createSuccessResult(verboseOut.length > 0 ? verboseOut.join('\n') + '\n' : '');
  }
}
