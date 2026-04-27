import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'uniq' command.
 *
 * Supported options:
 *   -c, --count          Prefix each line by its count
 *   -d, --repeated       Only print duplicate lines (one per group)
 *   -D                   Print all lines of duplicate groups
 *   -u, --unique         Only print unique lines (not duplicated)
 *   -i, --ignore-case    Ignore case when comparing
 *   -f N, --skip-fields=N  Skip the first N fields before comparing
 *   -s N, --skip-chars=N   Skip the first N chars before comparing
 *   -w N, --check-chars=N  Compare no more than N chars per line
 *   -z, --zero-terminated  Use NUL as line separator
 *   --                   End of options
 *   -                    Read from stdin
 *
 * POSIX uniq accepts `uniq [INPUT [OUTPUT]]`: we honor that second form.
 */
export class UniqCommand implements ShellCommand {
  name = 'uniq';
  description = 'Report or omit repeated lines';
  usage = 'uniq [-cduDiz] [-f N] [-s N] [-w N] [--] [input [output]]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['c', 'd', 'D', 'u', 'i', 'z'],
      valueShort: ['f', 's', 'w'],
      booleanLong: ['count', 'repeated', 'unique', 'ignore-case', 'zero-terminated'],
      valueLong: ['skip-fields', 'skip-chars', 'check-chars'],
      longToShort: {
        count: 'c',
        repeated: 'd',
        unique: 'u',
        'ignore-case': 'i',
        'zero-terminated': 'z',
        'skip-fields': 'f',
        'skip-chars': 's',
        'check-chars': 'w',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      count: parsed.flags.has('c'),
      duplicatesOnly: parsed.flags.has('d'),
      allDuplicates: parsed.flags.has('D'),
      uniqueOnly: parsed.flags.has('u'),
      ignoreCase: parsed.flags.has('i'),
      skipFields: parsed.values.get('f') ? parseInt(parsed.values.get('f')!, 10) : 0,
      skipChars: parsed.values.get('s') ? parseInt(parsed.values.get('s')!, 10) : 0,
      checkChars: parsed.values.get('w') ? parseInt(parsed.values.get('w')!, 10) : Infinity,
    };

    const [inputFile, outputFile] = parsed.operands;

    // Load input
    let content: string;
    if (!inputFile || inputFile === '-') {
      content = input ?? '';
    } else {
      try {
        const absolutePath = resolvePath(inputFile, cwd);
        const stats = await this.fs.stat(absolutePath);
        if (stats.isDirectory()) {
          return createErrorResult(`${this.name}: ${inputFile}: Is a directory`);
        }
        content = await this.fs.readFile(absolutePath, 'utf8');
      } catch (error) {
        const { kind } = classifyFsError(error);
        if (kind === 'ENOENT') {
          return createErrorResult(`${this.name}: ${inputFile}: No such file or directory`);
        }
        if (kind === 'EACCES') {
          return createErrorResult(`${this.name}: ${inputFile}: Permission denied`);
        }
        return createErrorResult(`${this.name}: ${inputFile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const trailingNewline = content.endsWith('\n');
    const lines = content === '' ? [] : (trailingNewline ? content.slice(0, -1) : content).split('\n');

    const keyFor = (line: string): string => {
      let s = line;
      // skip-fields
      if (opts.skipFields > 0) {
        const m = new RegExp(`^(\\s*\\S+\\s+){${opts.skipFields}}`).exec(s);
        if (m) s = s.slice(m[0].length);
      }
      // skip-chars
      if (opts.skipChars > 0) s = s.slice(opts.skipChars);
      if (opts.checkChars !== Infinity) s = s.slice(0, opts.checkChars);
      if (opts.ignoreCase) s = s.toLowerCase();
      return s;
    };

    // Group consecutive matching lines by key, tracking representatives.
    const output: string[] = [];
    let groupStart = 0;
    while (groupStart < lines.length) {
      let groupEnd = groupStart + 1;
      const groupKey = keyFor(lines[groupStart]);
      while (groupEnd < lines.length && keyFor(lines[groupEnd]) === groupKey) {
        groupEnd++;
      }
      const groupSize = groupEnd - groupStart;
      const isDup = groupSize > 1;
      const showLine = opts.allDuplicates
        ? isDup // print all lines of duplicate groups
        : (opts.duplicatesOnly ? isDup : (opts.uniqueOnly ? !isDup : true));

      if (showLine) {
        if (opts.allDuplicates) {
          for (let j = groupStart; j < groupEnd; j++) {
            output.push(formatLine(lines[j], groupSize, opts.count));
          }
        } else {
          output.push(formatLine(lines[groupStart], groupSize, opts.count));
        }
      }
      groupStart = groupEnd;
    }

    const result = output.length > 0 ? output.join('\n') + '\n' : '';

    if (outputFile) {
      try {
        validateWritePath(outputFile, this.name, cwd);
        await this.fs.writeFile(resolvePath(outputFile, cwd), result, 'utf8');
        return createSuccessResult('');
      } catch (error) {
        return createErrorResult(`${this.name}: ${outputFile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return createSuccessResult(result);
  }
}

function formatLine(line: string, count: number, withCount: boolean): string {
  return withCount ? `${String(count).padStart(7)} ${line}` : line;
}
