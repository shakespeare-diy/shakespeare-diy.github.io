import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'sort' command.
 *
 * Supported options:
 *   -r, --reverse        Reverse the result of comparisons
 *   -n, --numeric-sort   Compare according to numeric value
 *   -g, --general-numeric-sort   Like -n, but handles floats/scientific notation
 *   -h, --human-numeric-sort     Compare human-readable numbers (e.g. 2K, 1G)
 *   -V, --version-sort   Natural/version ordering (e.g. 1.10 > 1.2)
 *   -M, --month-sort     Compare by month name (Jan < Feb < … < Dec)
 *   -u, --unique         Output only unique lines (based on key)
 *   -f, --ignore-case    Fold lower case to upper case
 *   -b, --ignore-leading-blanks  Ignore leading blanks when comparing
 *   -d, --dictionary-order        Consider only blanks and alphanumerics
 *   -s, --stable         Stabilize sort by disabling the last-resort compare
 *   -c, --check          Check whether input is sorted; do not sort
 *   -R, --random-sort    Sort by random hash of keys
 *   -k POS[,POS], --key=POS[,POS]   Sort via a key
 *   -t SEP, --field-separator=SEP   Use SEP instead of non-blank to blank transition
 *   -o FILE, --output=FILE          Write result to FILE instead of stdout
 *   --                   End of options
 *   -                    Read from stdin
 */
export class SortCommand implements ShellCommand {
  name = 'sort';
  description = 'Sort lines of text';
  usage = 'sort [-rnghVMufbdscR] [-k POS] [-t SEP] [-o FILE] [--] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['r', 'n', 'g', 'h', 'V', 'M', 'u', 'f', 'b', 'd', 's', 'c', 'R'],
      valueShort: ['k', 't', 'o'],
      booleanLong: [
        'reverse', 'numeric-sort', 'general-numeric-sort', 'human-numeric-sort',
        'version-sort', 'month-sort', 'unique', 'ignore-case',
        'ignore-leading-blanks', 'dictionary-order', 'stable', 'check', 'random-sort',
      ],
      valueLong: ['key', 'field-separator', 'output'],
      longToShort: {
        reverse: 'r',
        'numeric-sort': 'n',
        'general-numeric-sort': 'g',
        'human-numeric-sort': 'h',
        'version-sort': 'V',
        'month-sort': 'M',
        unique: 'u',
        'ignore-case': 'f',
        'ignore-leading-blanks': 'b',
        'dictionary-order': 'd',
        stable: 's',
        check: 'c',
        'random-sort': 'R',
        key: 'k',
        'field-separator': 't',
        output: 'o',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      reverse: parsed.flags.has('r'),
      numeric: parsed.flags.has('n') || parsed.flags.has('g'),
      humanNumeric: parsed.flags.has('h'),
      version: parsed.flags.has('V'),
      month: parsed.flags.has('M'),
      unique: parsed.flags.has('u'),
      ignoreCase: parsed.flags.has('f'),
      ignoreLeadingBlanks: parsed.flags.has('b'),
      dictionary: parsed.flags.has('d'),
      check: parsed.flags.has('c'),
      random: parsed.flags.has('R'),
      keySpec: parsed.values.get('k'),
      separator: parsed.values.get('t'),
      outputFile: parsed.values.get('o'),
    };

    // Collect input lines
    let lines: string[] = [];
    const files = parsed.operands;

    if (files.length === 0 || (files.length === 1 && files[0] === '-')) {
      if (input !== undefined) {
        lines = splitIntoLines(input);
      }
    } else {
      for (const file of files) {
        if (file === '-') {
          lines.push(...splitIntoLines(input ?? ''));
          continue;
        }
        try {
          const absolutePath = resolvePath(file, cwd);
          const stats = await this.fs.stat(absolutePath);
          if (stats.isDirectory()) {
            return createErrorResult(`${this.name}: read failed: ${file}: Is a directory`);
          }
          const content = await this.fs.readFile(absolutePath, 'utf8');
          lines.push(...splitIntoLines(content));
        } catch (error) {
          const { kind } = classifyFsError(error);
          if (kind === 'ENOENT') {
            return createErrorResult(`${this.name}: cannot read: ${file}: No such file or directory`);
          }
          if (kind === 'EACCES') {
            return createErrorResult(`${this.name}: cannot read: ${file}: Permission denied`);
          }
          return createErrorResult(`${this.name}: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    // Extract key
    const keyRange = opts.keySpec ? parseKeySpec(opts.keySpec) : undefined;
    const extractKey = (line: string): string => {
      if (!keyRange) return opts.ignoreLeadingBlanks ? line.replace(/^\s+/, '') : line;
      const sep = opts.separator ?? /\s+/;
      const fields = typeof sep === 'string' ? line.split(sep) : line.split(sep);
      const start = Math.max(0, keyRange.start - 1);
      const end = keyRange.end === undefined ? fields.length : keyRange.end;
      return fields.slice(start, end).join(typeof sep === 'string' ? sep : ' ');
    };

    // Compare function
    const compare = (a: string, b: string): number => {
      let ka = extractKey(a);
      let kb = extractKey(b);
      if (opts.ignoreCase) {
        ka = ka.toUpperCase();
        kb = kb.toUpperCase();
      }
      if (opts.ignoreLeadingBlanks) {
        ka = ka.replace(/^\s+/, '');
        kb = kb.replace(/^\s+/, '');
      }
      if (opts.dictionary) {
        ka = ka.replace(/[^\s\w]/g, '');
        kb = kb.replace(/[^\s\w]/g, '');
      }
      let cmp = 0;
      if (opts.numeric) {
        const na = parseFloat(ka);
        const nb = parseFloat(kb);
        const naValid = !isNaN(na);
        const nbValid = !isNaN(nb);
        if (naValid && nbValid) cmp = na - nb;
        else if (naValid) cmp = 1;
        else if (nbValid) cmp = -1;
        else cmp = 0;
      } else if (opts.humanNumeric) {
        cmp = parseHumanSize(ka) - parseHumanSize(kb);
      } else if (opts.version) {
        cmp = versionCompare(ka, kb);
      } else if (opts.month) {
        cmp = monthIndex(ka) - monthIndex(kb);
      } else {
        // POSIX default: byte-by-byte (C locale) comparison.
        cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      }
      return opts.reverse ? -cmp : cmp;
    };

    if (opts.check) {
      for (let i = 1; i < lines.length; i++) {
        if (compare(lines[i - 1], lines[i]) > 0) {
          return createErrorResult(`${this.name}: disorder on line ${i + 1}`, 1);
        }
      }
      return createSuccessResult('');
    }

    if (opts.random) {
      // Deterministic-enough randomization: shuffle via hash of line.
      lines.sort((a, b) => hashLine(a) - hashLine(b));
    } else {
      lines.sort(compare);
    }

    if (opts.unique) {
      const seen = new Set<string>();
      lines = lines.filter((line) => {
        const key = extractKey(opts.ignoreCase ? line.toUpperCase() : line);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const output = lines.length > 0 ? lines.join('\n') + '\n' : '';

    if (opts.outputFile) {
      try {
        validateWritePath(opts.outputFile, this.name, cwd);
        await this.fs.writeFile(resolvePath(opts.outputFile, cwd), output, 'utf8');
        return createSuccessResult('');
      } catch (error) {
        return createErrorResult(`${this.name}: ${opts.outputFile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return createSuccessResult(output);
  }
}

function splitIntoLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function parseKeySpec(spec: string): { start: number; end?: number } | undefined {
  // Supports: "2", "2,4", "2.1,3.5" (char positions are ignored).
  const m = /^(\d+)(?:\.\d+)?(?:,(\d+)(?:\.\d+)?)?/.exec(spec);
  if (!m) return undefined;
  return {
    start: parseInt(m[1], 10),
    end: m[2] !== undefined ? parseInt(m[2], 10) : undefined,
  };
}

function parseHumanSize(s: string): number {
  const m = /^\s*([-+]?\d*\.?\d+)\s*([KMGTPE]?)B?\s*/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  return n * (mult[unit] ?? 1);
}

function versionCompare(a: string, b: string): number {
  const segmentsA = a.split(/(\d+)/).filter((s) => s.length > 0);
  const segmentsB = b.split(/(\d+)/).filter((s) => s.length > 0);
  const len = Math.max(segmentsA.length, segmentsB.length);
  for (let i = 0; i < len; i++) {
    const sa = segmentsA[i] ?? '';
    const sb = segmentsB[i] ?? '';
    const na = parseInt(sa, 10);
    const nb = parseInt(sb, 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

function monthIndex(s: string): number {
  const trimmed = s.trim().toUpperCase().slice(0, 3);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const idx = months.indexOf(trimmed);
  return idx === -1 ? -1 : idx;
}

function hashLine(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}
