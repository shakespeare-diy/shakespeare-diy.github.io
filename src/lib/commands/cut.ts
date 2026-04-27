import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'cut' command.
 *
 * Supported options:
 *   -b LIST, --bytes=LIST             Select bytes (same as -c in our impl)
 *   -c LIST, --characters=LIST        Select characters
 *   -f LIST, --fields=LIST            Select fields
 *   -d DELIM, --delimiter=DELIM       Use DELIM (single char) instead of TAB
 *   -s, --only-delimited              Do not print lines without delimiters
 *   --complement                      Complement the set of selected positions
 *   --output-delimiter=STRING         Use STRING as the output delimiter
 *   -n                                (ignored; accepted for POSIX compat)
 *   -z, --zero-terminated             NUL-terminated input/output
 *   --                                End of options
 *   -                                 Read from stdin
 *
 * LIST syntax: N | N-M | N- | -M | comma-separated combinations (e.g. "1,3-5,7-")
 */
export class CutCommand implements ShellCommand {
  name = 'cut';
  description = 'Extract sections from lines';
  usage = 'cut (-b LIST | -c LIST | -f LIST) [-d DELIM] [-s] [--complement] [--output-delimiter=STR] [--] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['s', 'n', 'z'],
      valueShort: ['b', 'c', 'f', 'd'],
      booleanLong: ['only-delimited', 'complement', 'zero-terminated'],
      valueLong: ['bytes', 'characters', 'fields', 'delimiter', 'output-delimiter'],
      longToShort: {
        'only-delimited': 's',
        'zero-terminated': 'z',
        bytes: 'b',
        characters: 'c',
        fields: 'f',
        delimiter: 'd',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const complement = parsed.longFlags.has('complement');
    const outputDelimiter = parsed.values.get('output-delimiter');
    const onlyDelimited = parsed.flags.has('s');

    const bSpec = parsed.values.get('b');
    const cSpec = parsed.values.get('c');
    const fSpec = parsed.values.get('f');
    const delim = parsed.values.get('d') ?? '\t';

    const specsGiven = [bSpec, cSpec, fSpec].filter((s) => s !== undefined).length;
    if (specsGiven === 0) {
      return createErrorResult(`${this.name}: you must specify a list of bytes, characters, or fields`);
    }
    if (specsGiven > 1) {
      return createErrorResult(`${this.name}: only one type of list may be specified`);
    }

    let mode: 'char' | 'byte' | 'field';
    let rangesSpec: string;
    if (fSpec !== undefined) {
      mode = 'field';
      rangesSpec = fSpec;
    } else if (bSpec !== undefined) {
      mode = 'byte';
      rangesSpec = bSpec;
    } else {
      mode = 'char';
      rangesSpec = cSpec!;
    }

    let ranges: Range[];
    try {
      ranges = parseList(rangesSpec);
    } catch (error) {
      return createErrorResult(`${this.name}: ${error instanceof Error ? error.message : 'invalid list'}`);
    }

    // Collect input
    const files = parsed.operands.length > 0 ? parsed.operands : ['-'];
    let combined = '';
    for (const file of files) {
      if (file === '-') {
        combined += input ?? '';
        continue;
      }
      try {
        const absolutePath = resolvePath(file, cwd);
        const stats = await this.fs.stat(absolutePath);
        if (stats.isDirectory()) {
          return createErrorResult(`${this.name}: ${file}: Is a directory`);
        }
        combined += await this.fs.readFile(absolutePath, 'utf8');
      } catch (error) {
        const { kind } = classifyFsError(error);
        if (kind === 'ENOENT') return createErrorResult(`${this.name}: ${file}: No such file or directory`);
        if (kind === 'EACCES') return createErrorResult(`${this.name}: ${file}: Permission denied`);
        return createErrorResult(`${this.name}: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
    const content = combined;

    const trailingNewline = content.endsWith('\n');
    const lines = content === '' ? [] : (trailingNewline ? content.slice(0, -1) : content).split('\n');

    const outLines: string[] = [];
    for (const line of lines) {
      const processed = extractFromLine(line, mode, ranges, delim, outputDelimiter ?? delim, complement, onlyDelimited);
      if (processed === undefined) continue; // suppressed by -s
      outLines.push(processed);
    }

    const output = outLines.length > 0 ? outLines.join('\n') + '\n' : '';
    return createSuccessResult(output);
  }
}

type Range = { start: number; end: number }; // inclusive, 1-based; end may be Infinity

function parseList(listStr: string): Range[] {
  const parts = listStr.split(',');
  const ranges: Range[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (part.includes('-')) {
      const [l, r] = part.split('-', 2);
      const start = l === '' ? 1 : parseInt(l, 10);
      const end = r === '' ? Infinity : parseInt(r, 10);
      if (isNaN(start) || (r !== '' && isNaN(end))) {
        throw new Error(`invalid range: '${part}'`);
      }
      if (start < 1 || (end !== Infinity && end < start)) {
        throw new Error(`invalid range: '${part}'`);
      }
      ranges.push({ start, end });
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < 1) throw new Error(`invalid position: '${part}'`);
      ranges.push({ start: n, end: n });
    }
  }
  return ranges;
}

function isInRanges(pos: number, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (pos >= r.start && pos <= r.end) return true;
  }
  return false;
}

function extractFromLine(
  line: string,
  mode: 'char' | 'byte' | 'field',
  ranges: Range[],
  delim: string,
  outDelim: string,
  complement: boolean,
  onlyDelimited: boolean,
): string | undefined {
  if (mode === 'field') {
    if (!line.includes(delim)) {
      if (onlyDelimited) return undefined;
      return line;
    }
    const fields = line.split(delim);
    const selected: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const pos = i + 1;
      const inRange = isInRanges(pos, ranges);
      if (complement ? !inRange : inRange) selected.push(fields[i]);
    }
    return selected.join(outDelim);
  }

  // Byte/char modes: in our string model these are equivalent (UTF-16 units for now).
  const units = mode === 'char' ? Array.from(line) : line.split('');
  const selected: string[] = [];
  for (let i = 0; i < units.length; i++) {
    const pos = i + 1;
    const inRange = isInRanges(pos, ranges);
    if (complement ? !inRange : inRange) selected.push(units[i]);
  }
  return selected.join('');
}
