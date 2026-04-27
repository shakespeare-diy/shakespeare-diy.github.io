import { join } from "path-browserify";
import { isAbsolutePath } from "../security";

/**
 * Resolve a path argument to an absolute path.
 * - Absolute paths are returned as-is.
 * - Relative paths are resolved against `cwd`.
 */
export function resolvePath(path: string, cwd: string): string {
  if (isAbsolutePath(path)) return path;
  return join(cwd, path);
}

/**
 * Classify a filesystem error message as ENOENT, EACCES, EISDIR, etc.
 */
export function classifyFsError(err: unknown): { kind: 'ENOENT' | 'EACCES' | 'EISDIR' | 'ENOTDIR' | 'EEXIST' | 'OTHER'; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|no such file/i.test(message)) return { kind: 'ENOENT', message };
  if (/EACCES|permission/i.test(message)) return { kind: 'EACCES', message };
  if (/EISDIR|is a directory/i.test(message)) return { kind: 'EISDIR', message };
  if (/ENOTDIR|not a directory/i.test(message)) return { kind: 'ENOTDIR', message };
  if (/EEXIST|file exists/i.test(message)) return { kind: 'EEXIST', message };
  return { kind: 'OTHER', message };
}

/**
 * Result from parseOptions: parsed boolean flags, value-bearing options, positional operands.
 */
export interface ParsedOptions {
  /** Set of single-char boolean flags that were seen (e.g. 'l', 'a'). */
  flags: Set<string>;
  /** Long options (e.g. 'recursive') whose presence was seen. */
  longFlags: Set<string>;
  /** Values for options that take an argument (keyed by short char or long name). */
  values: Map<string, string>;
  /** Positional (non-option) arguments, in order. */
  operands: string[];
  /** Any unknown options encountered (for "invalid option" error reporting). */
  unknown: string[];
}

export interface OptionSpec {
  /** Single-char flag → no argument. */
  booleanShort?: string[];
  /** Single-char options that require a value (e.g. 'n' for -n 10). */
  valueShort?: string[];
  /** Long flags with no argument (e.g. 'recursive' for --recursive). */
  booleanLong?: string[];
  /** Long flags with a value (e.g. 'include' for --include=pat or --include pat). */
  valueLong?: string[];
  /**
   * If true, all remaining arguments after the first positional are treated
   * as operands. Used by commands like `echo` which don't parse interior flags.
   */
  stopAtFirstOperand?: boolean;
  /**
   * Map of short flag → canonical short flag. Used for aliasing (e.g. -R → -r).
   */
  shortAliases?: Record<string, string>;
  /**
   * Map of long flag → canonical short flag (e.g. --recursive → 'r').
   */
  longToShort?: Record<string, string>;
}

/**
 * POSIX-ish option parser.
 *
 * Supports:
 *   - Combined short flags: `-abc` === `-a -b -c`
 *   - Short option with value: `-n 10` or `-n10`
 *   - Long options: `--lines=10` or `--lines 10`
 *   - The `--` sentinel ends option parsing; everything after is an operand
 *   - `-` alone is an operand (commonly meaning stdin)
 *   - Numeric shortcut `-NUM` (e.g. `head -5`) is treated as a value of
 *     option 'n' when 'n' is in valueShort AND enableNumericShortcut is true
 */
export function parseOptions(
  args: string[],
  spec: OptionSpec,
  opts: { enableNumericShortcut?: boolean } = {}
): ParsedOptions {
  const result: ParsedOptions = {
    flags: new Set(),
    longFlags: new Set(),
    values: new Map(),
    operands: [],
    unknown: [],
  };

  const boolShort = new Set(spec.booleanShort ?? []);
  const valShort = new Set(spec.valueShort ?? []);
  const boolLong = new Set(spec.booleanLong ?? []);
  const valLong = new Set(spec.valueLong ?? []);
  const shortAliases = spec.shortAliases ?? {};
  const longToShort = spec.longToShort ?? {};

  const normalizeShort = (c: string): string => shortAliases[c] ?? c;

  let i = 0;
  let stopped = false;

  while (i < args.length) {
    const arg = args[i];

    if (stopped) {
      result.operands.push(arg);
      i++;
      continue;
    }

    // `--` sentinel
    if (arg === '--') {
      stopped = true;
      i++;
      continue;
    }

    // Lone `-` is an operand (stdin)
    if (arg === '-') {
      result.operands.push(arg);
      i++;
      if (spec.stopAtFirstOperand) stopped = true;
      continue;
    }

    // Long option `--name` or `--name=value`
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);

      // Map long → short when specified
      if (name in longToShort) {
        const shortName = longToShort[name];
        if (valShort.has(shortName)) {
          let v: string | undefined = inline;
          if (v === undefined) {
            i++;
            if (i >= args.length) {
              result.unknown.push(arg);
              continue;
            }
            v = args[i];
          }
          result.values.set(shortName, v);
        } else {
          result.flags.add(shortName);
        }
        i++;
        continue;
      }

      if (valLong.has(name)) {
        let v: string | undefined = inline;
        if (v === undefined) {
          i++;
          if (i >= args.length) {
            result.unknown.push(arg);
            continue;
          }
          v = args[i];
        }
        result.values.set(name, v);
        i++;
        continue;
      }

      if (boolLong.has(name)) {
        result.longFlags.add(name);
        i++;
        continue;
      }

      result.unknown.push(arg);
      i++;
      continue;
    }

    // Short options `-abc` or `-n10` or `-n 10`
    if (arg.startsWith('-') && arg.length > 1) {
      // Numeric shortcut -NUM (e.g. head -5 means -n 5)
      if (
        opts.enableNumericShortcut &&
        /^-\d+$/.test(arg) &&
        valShort.has('n')
      ) {
        result.values.set('n', arg.slice(1));
        i++;
        continue;
      }

      let j = 1;
      let consumedNext = false;
      while (j < arg.length) {
        const c = arg[j];
        const canonical = normalizeShort(c);

        if (valShort.has(canonical)) {
          // Everything after this char in the same arg is the value.
          const rest = arg.slice(j + 1);
          if (rest.length > 0) {
            result.values.set(canonical, rest);
          } else {
            // Value is the next argument.
            i++;
            consumedNext = true;
            if (i >= args.length) {
              result.unknown.push(`-${c}`);
              break;
            }
            result.values.set(canonical, args[i]);
          }
          break;
        }

        if (boolShort.has(canonical)) {
          result.flags.add(canonical);
          j++;
          continue;
        }

        result.unknown.push(`-${c}`);
        j++;
      }

      i++;
      if (consumedNext) continue;
      continue;
    }

    // Positional operand
    result.operands.push(arg);
    i++;
    if (spec.stopAtFirstOperand) stopped = true;
  }

  return result;
}

/**
 * Split input text into lines, preserving knowledge of whether the
 * final line had a trailing newline. Useful for line-oriented commands
 * that need to reconstruct output faithfully.
 */
export function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content === '') return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith('\n');
  const body = trailingNewline ? content.slice(0, -1) : content;
  return { lines: body.split('\n'), trailingNewline };
}

/**
 * Join lines back into content, re-adding the trailing newline if one
 * was present in the original input.
 */
export function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/**
 * Format an "invalid option" error line.
 */
export function invalidOptionError(cmd: string, opt: string): string {
  return `${cmd}: invalid option -- '${opt.replace(/^-+/, '')}'`;
}
