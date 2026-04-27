import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'head' command.
 *
 * Supported options:
 *   -n NUM, --lines=NUM   Print first NUM lines (default 10)
 *                         NUM may be prefixed with '-' (already implicit),
 *                         or with '+' to print all but the last NUM lines
 *                         when combined with a negative interpretation —
 *                         for head, POSIX: `-n -K` means all but last K.
 *   -c NUM, --bytes=NUM   Print first NUM bytes
 *   -q, --quiet, --silent Suppress headers when multiple files
 *   -v, --verbose         Always print headers
 *   -NUM                  Shorthand for -n NUM (e.g. `head -5 file`)
 *   --                    End of options
 *   -                     Read from stdin
 */
export class HeadCommand implements ShellCommand {
  name = 'head';
  description = 'Display the first lines of files';
  usage = 'head [-n NUM] [-c NUM] [-qv] [--] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['q', 'v'],
      valueShort: ['n', 'c'],
      booleanLong: ['quiet', 'silent', 'verbose'],
      valueLong: ['lines', 'bytes'],
      longToShort: {
        quiet: 'q', silent: 'q', verbose: 'v',
        lines: 'n', bytes: 'c',
      },
    }, { enableNumericShortcut: true });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const linesArg = parsed.values.get('n');
    const bytesArg = parsed.values.get('c');

    let lines = 10;
    let linesNegative = false;
    if (linesArg !== undefined) {
      const n = parseIntStrict(linesArg);
      if (n === undefined) return createErrorResult(`${this.name}: invalid number of lines: '${linesArg}'`);
      if (n < 0) { lines = -n; linesNegative = true; }
      else lines = n;
    }

    let bytes: number | undefined;
    let bytesNegative = false;
    if (bytesArg !== undefined) {
      const n = parseIntStrict(bytesArg);
      if (n === undefined) return createErrorResult(`${this.name}: invalid number of bytes: '${bytesArg}'`);
      if (n < 0) { bytes = -n; bytesNegative = true; }
      else bytes = n;
    }

    const quiet = parsed.flags.has('q');
    const verbose = parsed.flags.has('v');

    const files = parsed.operands.length > 0 ? parsed.operands : ['-'];
    const outputs: string[] = [];
    const showHeaders = verbose || (!quiet && files.length > 1);

    for (let idx = 0; idx < files.length; idx++) {
      const filePath = files[idx];
      let content: string;

      if (filePath === '-') {
        content = input ?? '';
      } else {
        try {
          const absolutePath = resolvePath(filePath, cwd);
          const stats = await this.fs.stat(absolutePath);
          if (stats.isDirectory()) {
            return createErrorResult(`${this.name}: error reading '${filePath}': Is a directory`);
          }
          content = await this.fs.readFile(absolutePath, 'utf8');
        } catch (error) {
          const { kind } = classifyFsError(error);
          if (kind === 'ENOENT') {
            return createErrorResult(`${this.name}: cannot open '${filePath}' for reading: No such file or directory`);
          }
          if (kind === 'EACCES') {
            return createErrorResult(`${this.name}: cannot open '${filePath}' for reading: Permission denied`);
          }
          return createErrorResult(`${this.name}: ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      if (showHeaders) {
        if (idx > 0) outputs.push('');
        outputs.push(`==> ${filePath} <==`);
      }

      if (bytes !== undefined) {
        const sliced = bytesNegative
          ? content.slice(0, Math.max(0, content.length - bytes))
          : content.slice(0, bytes);
        outputs.push(sliced);
      } else {
        const allLines = content.split('\n');
        // Split typically produces one extra empty trailing element when the
        // file ends with a newline; we preserve logical line count.
        const logical = content.endsWith('\n') ? allLines.slice(0, -1) : allLines;
        const count = linesNegative
          ? Math.max(0, logical.length - lines)
          : Math.min(lines, logical.length);
        const selected = logical.slice(0, count);
        outputs.push(selected.join('\n') + (selected.length > 0 ? '\n' : ''));
      }
    }

    // Concatenate; the per-chunk trailing newlines ensure correct joining.
    return createSuccessResult(normalizeOutput(outputs));
  }
}

function parseIntStrict(s: string): number | undefined {
  // Accept forms: "10", "-10", "+10"
  if (!/^[-+]?\d+$/.test(s)) return undefined;
  return parseInt(s, 10);
}

function normalizeOutput(chunks: string[]): string {
  // Join chunks with newlines only when a header/empty divider exists
  let out = '';
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === '' && i > 0) {
      // Blank line between file headers.
      if (!out.endsWith('\n')) out += '\n';
      out += '\n';
      continue;
    }
    if (i > 0 && !out.endsWith('\n')) out += '\n';
    out += c;
  }
  return out;
}
