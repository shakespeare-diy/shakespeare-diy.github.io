import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'wc' command.
 *
 * Supported options:
 *   -l, --lines          Count newlines
 *   -w, --words          Count whitespace-delimited words
 *   -c, --bytes          Count bytes (UTF-8)
 *   -m, --chars          Count characters (code points)
 *   -L, --max-line-length  Print the longest line length
 *   --                   End of options
 *   -                    Read from stdin
 *
 * Default (no count options) prints: lines, words, bytes.
 */
export class WcCommand implements ShellCommand {
  name = 'wc';
  description = 'Count lines, words, and characters in files';
  usage = 'wc [-lwcmL] [--] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['l', 'w', 'c', 'm', 'L'],
      booleanLong: ['lines', 'words', 'bytes', 'chars', 'max-line-length'],
      longToShort: {
        lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    let opts = {
      lines: parsed.flags.has('l'),
      words: parsed.flags.has('w'),
      bytes: parsed.flags.has('c'),
      chars: parsed.flags.has('m'),
      maxLine: parsed.flags.has('L'),
    };

    // Default: -lwc
    if (!opts.lines && !opts.words && !opts.bytes && !opts.chars && !opts.maxLine) {
      opts = { lines: true, words: true, bytes: true, chars: false, maxLine: false };
    }

    const files = parsed.operands.length > 0 ? parsed.operands : ['-'];
    const results: Array<{ counts: Counts; name: string }> = [];
    const total: Counts = { lines: 0, words: 0, bytes: 0, chars: 0, maxLine: 0 };

    for (const filePath of files) {
      let content: string;
      if (filePath === '-') {
        content = input ?? '';
      } else {
        try {
          const absolutePath = resolvePath(filePath, cwd);
          const stats = await this.fs.stat(absolutePath);
          if (stats.isDirectory()) {
            return createErrorResult(`${this.name}: ${filePath}: Is a directory`);
          }
          content = await this.fs.readFile(absolutePath, 'utf8');
        } catch (error) {
          const { kind } = classifyFsError(error);
          if (kind === 'ENOENT') {
            return createErrorResult(`${this.name}: ${filePath}: No such file or directory`);
          }
          if (kind === 'EACCES') {
            return createErrorResult(`${this.name}: ${filePath}: Permission denied`);
          }
          return createErrorResult(`${this.name}: ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      const counts = countContent(content);
      results.push({ counts, name: filePath === '-' ? '' : filePath });
      total.lines += counts.lines;
      total.words += counts.words;
      total.bytes += counts.bytes;
      total.chars += counts.chars;
      if (counts.maxLine > total.maxLine) total.maxLine = counts.maxLine;
    }

    const format = (c: Counts, name: string): string => {
      const parts: string[] = [];
      if (opts.lines) parts.push(String(c.lines).padStart(8));
      if (opts.words) parts.push(String(c.words).padStart(8));
      if (opts.bytes) parts.push(String(c.bytes).padStart(8));
      if (opts.chars) parts.push(String(c.chars).padStart(8));
      if (opts.maxLine) parts.push(String(c.maxLine).padStart(8));
      if (name) parts.push(name);
      return parts.join(' ').replace(/^ /, '');
    };

    const outputs = results.map((r) => format(r.counts, r.name));
    if (results.length > 1) outputs.push(format(total, 'total'));

    return createSuccessResult(outputs.join('\n') + (outputs.length > 0 ? '\n' : ''));
  }
}

interface Counts {
  lines: number;
  words: number;
  bytes: number;
  chars: number;
  maxLine: number;
}

function countContent(content: string): Counts {
  const lines = (content.match(/\n/g) ?? []).length;
  const trimmed = content.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  // POSIX -c is bytes: count UTF-8 byte length.
  const bytes = new TextEncoder().encode(content).length;
  // -m is characters (code points).
  let chars = 0;
  for (const _ of content) chars++;
  // -L: max line length (without the trailing newline).
  let maxLine = 0;
  for (const line of content.split('\n')) {
    if (line.length > maxLine) maxLine = line.length;
  }
  return { lines, words, bytes, chars, maxLine };
}
