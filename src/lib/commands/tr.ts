import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'tr' command.
 *
 * Supported options:
 *   -c, -C, --complement  Use the complement of SET1
 *   -d, --delete          Delete characters in SET1 (do not translate)
 *   -s, --squeeze-repeats Replace runs of repeated chars in SET1 (or SET2
 *                         with -d) with a single occurrence
 *   -t, --truncate-set1   Truncate SET1 to the length of SET2
 *   --                    End of options
 *
 * Supported SET syntax:
 *   literal characters, a-z ranges, backslash escapes
 *   (\\ \a \b \f \n \r \t \v \NNN \xHH), and character classes:
 *   [:alpha:] [:alnum:] [:digit:] [:lower:] [:upper:] [:space:]
 *   [:blank:] [:punct:] [:print:] [:graph:] [:cntrl:] [:xdigit:]
 *
 * Note: POSIX `tr` reads only from stdin. As a convenience, this
 * implementation also accepts filename operands after the SETs.
 */
export class TrCommand implements ShellCommand {
  name = 'tr';
  description = 'Translate or delete characters';
  usage = 'tr [-cCdst] [--] SET1 [SET2] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['c', 'C', 'd', 's', 't'],
      booleanLong: ['complement', 'delete', 'squeeze-repeats', 'truncate-set1'],
      longToShort: {
        complement: 'c',
        delete: 'd',
        'squeeze-repeats': 's',
        'truncate-set1': 't',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      complement: parsed.flags.has('c') || parsed.flags.has('C'),
      delete: parsed.flags.has('d'),
      squeeze: parsed.flags.has('s'),
      truncate: parsed.flags.has('t'),
    };

    if (parsed.operands.length === 0) {
      return createErrorResult(`${this.name}: missing operand`);
    }

    const set1 = parsed.operands[0];
    let set2: string | undefined;
    let fileStart = 1;

    if (!opts.delete) {
      if (parsed.operands.length < 2 && !opts.squeeze) {
        return createErrorResult(`${this.name}: missing operand after '${set1}'`);
      }
      if (parsed.operands.length >= 2) {
        set2 = parsed.operands[1];
        fileStart = 2;
      }
    }

    const files = parsed.operands.slice(fileStart);

    // Collect input
    let content = '';
    if (files.length === 0) {
      content = input ?? '';
    } else {
      for (const file of files) {
        if (file === '-') {
          content += input ?? '';
          continue;
        }
        try {
          const absolutePath = resolvePath(file, cwd);
          const stats = await this.fs.stat(absolutePath);
          if (stats.isDirectory()) {
            return createErrorResult(`${this.name}: ${file}: Is a directory`);
          }
          content += await this.fs.readFile(absolutePath, 'utf8');
        } catch (error) {
          const { kind } = classifyFsError(error);
          if (kind === 'ENOENT') return createErrorResult(`${this.name}: ${file}: No such file or directory`);
          if (kind === 'EACCES') return createErrorResult(`${this.name}: ${file}: Permission denied`);
          return createErrorResult(`${this.name}: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    let s1: string[];
    let s2: string[] | undefined;
    try {
      s1 = expandSet(set1);
      if (set2 !== undefined) s2 = expandSet(set2);
    } catch (error) {
      return createErrorResult(`${this.name}: ${error instanceof Error ? error.message : 'invalid set'}`);
    }

    // Complement SET1 — when used with -d alone, this is a "delete everything NOT in SET1" mode.
    // When used with translation, POSIX defines complement to be the set of bytes not in SET1,
    // and we fold unknown chars in the input through it. We approximate with a set-membership test.
    const set1IsComplement = opts.complement;
    const set1Set = new Set(s1);
    const inS1 = (ch: string) => set1IsComplement ? !set1Set.has(ch) : set1Set.has(ch);

    let result = '';

    if (opts.delete) {
      // -d: delete chars in SET1 (or not-in-SET1 if -c). Then optionally -s on SET2.
      for (const ch of content) {
        if (!inS1(ch)) result += ch;
      }
      if (opts.squeeze && s2) {
        result = squeezeRuns(result, new Set(s2));
      }
    } else if (s2) {
      // Translate: build map.
      if (opts.truncate && s1.length > s2.length) {
        s1 = s1.slice(0, s2.length);
      }
      const map = new Map<string, string>();
      for (let i = 0; i < s1.length; i++) {
        const replacement = i < s2.length ? s2[i] : s2[s2.length - 1];
        map.set(s1[i], replacement);
      }
      for (const ch of content) {
        if (inS1(ch)) {
          // When complement+translate, per POSIX substitute the last char of SET2.
          result += set1IsComplement ? s2[s2.length - 1] : map.get(ch) ?? ch;
        } else {
          result += ch;
        }
      }
      if (opts.squeeze) {
        result = squeezeRuns(result, new Set(s2));
      }
    } else if (opts.squeeze) {
      // -s only: squeeze runs of chars in SET1.
      result = squeezeRuns(content, new Set(s1), set1IsComplement);
    } else {
      result = content;
    }

    return createSuccessResult(result);
  }
}

function expandSet(set: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < set.length) {
    // [:class:] handling
    if (set[i] === '[' && set[i + 1] === ':') {
      const close = set.indexOf(':]', i + 2);
      if (close !== -1) {
        const name = set.slice(i + 2, close);
        const chars = expandClass(name);
        out.push(...chars);
        i = close + 2;
        continue;
      }
    }
    // Escape sequences
    if (set[i] === '\\' && i + 1 < set.length) {
      const [ch, consumed] = readEscape(set, i);
      // Handle range with escaped char
      if (i + consumed < set.length && set[i + consumed] === '-' && i + consumed + 1 < set.length) {
        const [endCh, endConsumed] = readEscape(set, i + consumed + 1);
        for (let c = ch.charCodeAt(0); c <= endCh.charCodeAt(0); c++) {
          out.push(String.fromCharCode(c));
        }
        i += consumed + 1 + endConsumed;
        continue;
      }
      out.push(ch);
      i += consumed;
      continue;
    }
    // Range a-z
    if (i + 2 < set.length && set[i + 1] === '-') {
      const start = set.charCodeAt(i);
      const end = set.charCodeAt(i + 2);
      if (start <= end) {
        for (let c = start; c <= end; c++) out.push(String.fromCharCode(c));
        i += 3;
        continue;
      }
    }
    out.push(set[i]);
    i++;
  }
  return out;
}

function readEscape(s: string, i: number): [string, number] {
  const next = s[i + 1];
  switch (next) {
    case '\\': return ['\\', 2];
    case 'a': return ['\x07', 2];
    case 'b': return ['\b', 2];
    case 'f': return ['\f', 2];
    case 'n': return ['\n', 2];
    case 'r': return ['\r', 2];
    case 't': return ['\t', 2];
    case 'v': return ['\v', 2];
    case 'x': {
      let j = i + 2;
      let hex = '';
      while (j < s.length && hex.length < 2 && /[0-9a-fA-F]/.test(s[j])) {
        hex += s[j]; j++;
      }
      return [hex ? String.fromCharCode(parseInt(hex, 16)) : 'x', hex ? j - i : 2];
    }
    default: {
      if (/[0-7]/.test(next)) {
        let j = i + 1;
        let oct = '';
        while (j < s.length && oct.length < 3 && /[0-7]/.test(s[j])) {
          oct += s[j]; j++;
        }
        return [String.fromCharCode(parseInt(oct, 8)), j - i];
      }
      return [next, 2];
    }
  }
}

function expandClass(name: string): string[] {
  const chars: string[] = [];
  const add = (re: RegExp) => {
    for (let c = 0; c < 128; c++) {
      const ch = String.fromCharCode(c);
      if (re.test(ch)) chars.push(ch);
    }
  };
  switch (name) {
    case 'alpha': add(/[A-Za-z]/); break;
    case 'alnum': add(/[A-Za-z0-9]/); break;
    case 'digit': add(/[0-9]/); break;
    case 'lower': add(/[a-z]/); break;
    case 'upper': add(/[A-Z]/); break;
    case 'space': add(/[\s]/); break;
    case 'blank': chars.push(' ', '\t'); break;
    case 'punct': add(/[!-/:-@[-`{-~]/); break;
    case 'print': add(/[ -~]/); break;
    case 'graph': add(/[!-~]/); break;
    case 'cntrl':
      for (let c = 0; c < 32; c++) chars.push(String.fromCharCode(c));
      chars.push('\x7f');
      break;
    case 'xdigit': add(/[0-9A-Fa-f]/); break;
    default:
      throw new Error(`invalid character class '[:${name}:]'`);
  }
  return chars;
}

function squeezeRuns(s: string, set: Set<string>, complement = false): string {
  let out = '';
  let prev = '';
  for (const ch of s) {
    const inSet = complement ? !set.has(ch) : set.has(ch);
    if (inSet && ch === prev) continue;
    out += ch;
    prev = ch;
  }
  return out;
}
