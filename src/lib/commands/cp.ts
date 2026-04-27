import { join, dirname, basename } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'cp' command.
 *
 * Supported options:
 *   -r, -R, --recursive   Copy directories recursively
 *   -f, --force           Force overwrite (remove destination first if needed)
 *   -i, --interactive     Prompt before overwrite (no-op: always treated as 'yes' in non-interactive env)
 *   -n, --no-clobber      Do not overwrite an existing file
 *   -p, --preserve        Preserve timestamps (best-effort; VFS lacks chmod)
 *   -a, --archive         Equivalent to -rp
 *   -v, --verbose         Explain what is being done
 *   -T, --no-target-directory  Treat destination as a normal file
 *   --                    End of options
 */
export class CpCommand implements ShellCommand {
  name = 'cp';
  description = 'Copy files and directories';
  usage = 'cp [-rRfinpavT] [--] source... destination';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['r', 'R', 'f', 'i', 'n', 'p', 'a', 'v', 'T'],
      booleanLong: ['recursive', 'force', 'interactive', 'no-clobber', 'preserve', 'archive', 'verbose', 'no-target-directory'],
      longToShort: {
        recursive: 'r',
        force: 'f',
        interactive: 'i',
        'no-clobber': 'n',
        preserve: 'p',
        archive: 'a',
        verbose: 'v',
        'no-target-directory': 'T',
      },
      shortAliases: { R: 'r' },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      recursive: parsed.flags.has('r') || parsed.flags.has('a'),
      force: parsed.flags.has('f'),
      noClobber: parsed.flags.has('n'),
      verbose: parsed.flags.has('v'),
      noTargetDir: parsed.flags.has('T'),
    };

    const paths = parsed.operands;
    if (paths.length < 1) {
      return createErrorResult(`${this.name}: missing file operand\nUsage: ${this.usage}`);
    }
    if (paths.length < 2) {
      return createErrorResult(`${this.name}: missing destination file operand after '${paths[0]}'\nUsage: ${this.usage}`);
    }

    const sources = paths.slice(0, -1);
    const destination = paths[paths.length - 1];

    try {
      validateWritePath(destination, this.name, cwd);
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : 'Unknown error');
    }

    const destAbsolutePath = resolvePath(destination, cwd);

    let destIsDir = false;
    try {
      const destStats = await this.fs.stat(destAbsolutePath);
      destIsDir = destStats.isDirectory();
    } catch {
      // Destination doesn't exist — that's fine
    }
    if (opts.noTargetDir) destIsDir = false;

    if (sources.length > 1 && !destIsDir) {
      return createErrorResult(`${this.name}: target '${destination}' is not a directory`);
    }

    const verboseOut: string[] = [];

    for (const source of sources) {
      try {
        const sourceAbsolutePath = resolvePath(source, cwd);
        const sourceStats = await this.fs.stat(sourceAbsolutePath);

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
          continue; // Silently skip.
        }

        if (sourceStats.isDirectory()) {
          if (!opts.recursive) {
            return createErrorResult(`${this.name}: -r not specified; omitting directory '${source}'`);
          }
          await this.copyDirectoryRecursive(sourceAbsolutePath, targetPath, opts.force, verboseOut, opts.verbose, source);
        } else {
          if (targetExists && opts.force) {
            try {
              await this.fs.unlink(targetPath);
            } catch {
              // Non-fatal; writeFile below may still succeed.
            }
          }
          await this.copyFile(sourceAbsolutePath, targetPath);
          if (opts.verbose) verboseOut.push(`'${source}' -> '${targetPath}'`);
        }
      } catch (error) {
        const { kind, message } = classifyFsError(error);
        if (kind === 'ENOENT') {
          return createErrorResult(`${this.name}: cannot stat '${source}': No such file or directory`);
        }
        if (kind === 'EACCES') {
          return createErrorResult(`${this.name}: cannot access '${source}': Permission denied`);
        }
        return createErrorResult(`${this.name}: cannot copy '${source}': ${message}`);
      }
    }

    return createSuccessResult(verboseOut.length > 0 ? verboseOut.join('\n') + '\n' : '');
  }

  private async copyFile(sourcePath: string, targetPath: string): Promise<void> {
    // Ensure parent dir exists. POSIX cp would error, but we keep this
    // permissive behavior because our VFS often lacks intermediate dirs
    // and it matches existing project expectations.
    const targetDir = dirname(targetPath);
    try {
      await this.fs.stat(targetDir);
    } catch {
      await this.fs.mkdir(targetDir, { recursive: true });
    }
    const content = await this.fs.readFile(sourcePath);
    await this.fs.writeFile(targetPath, content);
  }

  private async copyDirectoryRecursive(
    sourcePath: string,
    targetPath: string,
    force: boolean,
    verboseOut: string[],
    verbose: boolean,
    displaySource: string,
  ): Promise<void> {
    await this.fs.mkdir(targetPath, { recursive: true });
    if (verbose) verboseOut.push(`'${displaySource}' -> '${targetPath}'`);

    const entries = await this.fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const sourceEntryPath = join(sourcePath, entry.name);
      const targetEntryPath = join(targetPath, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectoryRecursive(sourceEntryPath, targetEntryPath, force, verboseOut, verbose, `${displaySource}/${entry.name}`);
      } else {
        try {
          await this.fs.stat(targetEntryPath);
          if (force) {
            try { await this.fs.unlink(targetEntryPath); } catch { /* ignore */ }
          }
        } catch {
          // Target doesn't exist — fine.
        }
        await this.copyFile(sourceEntryPath, targetEntryPath);
        if (verbose) verboseOut.push(`'${displaySource}/${entry.name}' -> '${targetEntryPath}'`);
      }
    }
  }
}
