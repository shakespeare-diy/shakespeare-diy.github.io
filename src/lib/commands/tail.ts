import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'tail' command.
 *
 * Supported options:
 *   -n NUM, --lines=NUM   Print last NUM lines (default 10). `-n +K` prints
 *                         starting from line K (1-indexed).
 *   -c NUM, --bytes=NUM   Print last NUM bytes. `-c +K` starts from byte K.
 *   -q, --quiet, --silent Suppress headers when multiple files
 *   -v, --verbose         Always print headers
 *   -NUM                  Shorthand for -n NUM
 *   --                    End of options
 *   -                     Read from stdin
 */
export class TailCommand implements ShellCommand {
  name = 'tail';
  description = 'Display the last lines of files';
  usage = 'tail [-n NUM] [-c NUM] [-qv] [--] [file...]';

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

    let lineCount = 10;
    let linesFromStart = false; // -n +K: start from line K
    if (linesArg !== undefined) {
      const parsedLines = parseCountArg(linesArg);
      if (!parsedLines) return createErrorResult(`${this.name}: invalid number of lines: '${linesArg}'`);
      lineCount = parsedLines.n;
      linesFromStart = parsedLines.fromStart;
    }

    let byteCount: number | undefined;
    let bytesFromStart = false;
    if (bytesArg !== undefined) {
      const parsedBytes = parseCountArg(bytesArg);
      if (!parsedBytes) return createErrorResult(`${this.name}: invalid number of bytes: '${bytesArg}'`);
      byteCount = parsedBytes.n;
      bytesFromStart = parsedBytes.fromStart;
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

      if (byteCount !== undefined) {
        const result = bytesFromStart
          ? content.slice(Math.max(0, byteCount - 1))
          : content.slice(Math.max(0, content.length - byteCount));
        outputs.push(result);
      } else {
        const lines = content.split('\n');
        // If file ends with newline, split produces a trailing empty string.
        if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) {
          lines.pop();
        }
        const selected = linesFromStart
          ? lines.slice(Math.max(0, lineCount - 1))
          : lines.slice(-lineCount);
        outputs.push(selected.join('\n') + (selected.length > 0 ? '\n' : ''));
      }
    }

    return createSuccessResult(normalizeOutput(outputs));
  }
}

/** Parse `-n NUM` or `-n +NUM` / `-n -NUM` arguments. */
function parseCountArg(s: string): { n: number; fromStart: boolean } | undefined {
  if (s.startsWith('+')) {
    if (!/^\+\d+$/.test(s)) return undefined;
    return { n: parseInt(s.slice(1), 10), fromStart: true };
  }
  if (!/^-?\d+$/.test(s)) return undefined;
  const raw = parseInt(s, 10);
  return { n: Math.abs(raw), fromStart: false };
}

function normalizeOutput(chunks: string[]): string {
  let out = '';
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === '' && i > 0) {
      if (!out.endsWith('\n')) out += '\n';
      out += '\n';
      continue;
    }
    if (i > 0 && !out.endsWith('\n')) out += '\n';
    out += c;
  }
  return out;
}
