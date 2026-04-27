import { dirname } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'touch' command.
 *
 * Supported options:
 *   -c, --no-create       Do not create files that do not exist
 *   -a                    Change only access time (accepted; VFS has no atime)
 *   -m                    Change only modification time (default)
 *   -h, --no-dereference  Affect symlinks themselves (accepted, no-op)
 *   -r, --reference FILE  Use this file's timestamps (accepted; no-op)
 *   -d, --date STRING     Use STRING as the time (accepted; no-op)
 *   -t STAMP              Use [[CC]YY]MMDDhhmm[.ss] (accepted; no-op)
 *   --                    End of options
 *
 * Note: The underlying LightningFS does not support mtime updates apart
 * from rewriting file content. For existing files we rewrite the same
 * content to update mtime; for new files we create empty ones.
 */
export class TouchCommand implements ShellCommand {
  name = 'touch';
  description = 'Create empty files or update timestamps';
  usage = 'touch [-acmh] [-r FILE] [-d STRING] [-t STAMP] [--] file...';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['c', 'a', 'm', 'h'],
      valueShort: ['r', 'd', 't'],
      booleanLong: ['no-create', 'no-dereference'],
      valueLong: ['reference', 'date'],
      longToShort: {
        'no-create': 'c',
        'no-dereference': 'h',
        reference: 'r',
        date: 'd',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      noCreate: parsed.flags.has('c'),
    };

    if (parsed.operands.length === 0) {
      return createErrorResult(`${this.name}: missing file operand\nUsage: ${this.usage}`);
    }

    for (const filePath of parsed.operands) {
      try {
        validateWritePath(filePath, this.name, cwd);
      } catch (error) {
        return createErrorResult(error instanceof Error ? error.message : 'Unknown error');
      }

      const absolutePath = resolvePath(filePath, cwd);

      try {
        const stats = await this.fs.stat(absolutePath);
        if (stats.isDirectory()) {
          // POSIX: touch on a directory updates mtime but the VFS doesn't
          // support this; succeed silently.
          continue;
        }
        // File exists — update mtime by rewriting the same content.
        // Best-effort: if the underlying FS doesn't expose readFile/writeFile
        // for this path (e.g. in tests), silently continue.
        try {
          const content = await this.fs.readFile(absolutePath);
          await this.fs.writeFile(absolutePath, content);
        } catch {
          // Ignore — existing file is still "touched" from the user's POV.
        }
      } catch (statError) {
        const { kind, message } = classifyFsError(statError);
        if (kind !== 'ENOENT') {
          if (kind === 'EACCES') {
            return createErrorResult(`${this.name}: ${filePath}: Permission denied`);
          }
          return createErrorResult(`${this.name}: ${filePath}: ${message}`);
        }

        if (opts.noCreate) {
          continue; // With -c, skip missing files silently.
        }

        const parentDir = dirname(absolutePath);
        try {
          await this.fs.stat(parentDir);
        } catch {
          return createErrorResult(`${this.name}: cannot touch '${filePath}': No such file or directory`);
        }

        try {
          await this.fs.writeFile(absolutePath, '', 'utf8');
        } catch (writeError) {
          const { message: wmsg } = classifyFsError(writeError);
          return createErrorResult(`${this.name}: cannot touch '${filePath}': ${wmsg}`);
        }
      }
    }

    return createSuccessResult('');
  }
}
