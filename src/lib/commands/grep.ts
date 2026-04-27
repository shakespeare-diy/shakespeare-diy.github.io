import { join } from "path-browserify";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'grep' command.
 *
 * Supported options:
 *   -E, --extended-regexp   Use extended regular expressions (default here)
 *   -F, --fixed-strings     Interpret pattern as fixed strings
 *   -G, --basic-regexp      Use basic regular expressions (approximated)
 *   -e PATTERN              Use PATTERN for matching (may be repeated)
 *   -f FILE                 Read patterns from FILE
 *   -i, --ignore-case       Ignore case distinctions
 *   -v, --invert-match      Select non-matching lines
 *   -w, --word-regexp       Only match whole words
 *   -x, --line-regexp       Only match whole lines
 *   -c, --count             Print only a count of matching lines per file
 *   -l, --files-with-matches   Print only names of files with matches
 *   -L, --files-without-match  Print only names of files with no matches
 *   -n, --line-number       Print line numbers
 *   -H, --with-filename     Print filename for each match
 *   -h, --no-filename       Suppress filename
 *   -o, --only-matching     Print only matched parts of lines
 *   -q, --quiet, --silent   Exit 0 on match, 1 otherwise; no output
 *   -r, --recursive         Search recursively
 *   -R, --dereference-recursive   Recursively follow symlinks
 *   -s, --no-messages       Suppress error messages
 *   -A NUM                  Print NUM lines of trailing context
 *   -B NUM                  Print NUM lines of leading context
 *   -C NUM                  Print NUM lines of both context
 *   --include=GLOB          Limit recursive search to files matching GLOB
 *   --exclude=GLOB          Skip files matching GLOB
 *   --exclude-dir=GLOB      Skip directories matching GLOB
 *   --color[=WHEN]          Accepted, color output is not implemented
 *   --                      End of options
 *   -                       Read from stdin
 */
export class GrepCommand implements ShellCommand {
  name = 'grep';
  description = 'Search for patterns in files';
  usage = 'grep [-EFGivwxclLnHhoqrRs] [-A NUM] [-B NUM] [-C NUM] [-e PATTERN] [-f FILE] [--include GLOB] [--exclude GLOB] [--] PATTERN [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['E', 'F', 'G', 'i', 'v', 'w', 'x', 'c', 'l', 'L', 'n', 'H', 'h', 'o', 'q', 'r', 'R', 's'],
      valueShort: ['A', 'B', 'C', 'e', 'f'],
      booleanLong: [
        'extended-regexp', 'fixed-strings', 'basic-regexp',
        'ignore-case', 'invert-match', 'word-regexp', 'line-regexp',
        'count', 'files-with-matches', 'files-without-match',
        'line-number', 'with-filename', 'no-filename', 'only-matching',
        'quiet', 'silent', 'recursive', 'dereference-recursive', 'no-messages',
      ],
      valueLong: ['include', 'exclude', 'exclude-dir', 'color', 'colour', 'regexp', 'file'],
      longToShort: {
        'extended-regexp': 'E',
        'fixed-strings': 'F',
        'basic-regexp': 'G',
        'ignore-case': 'i',
        'invert-match': 'v',
        'word-regexp': 'w',
        'line-regexp': 'x',
        count: 'c',
        'files-with-matches': 'l',
        'files-without-match': 'L',
        'line-number': 'n',
        'with-filename': 'H',
        'no-filename': 'h',
        'only-matching': 'o',
        quiet: 'q',
        silent: 'q',
        recursive: 'r',
        'dereference-recursive': 'R',
        'no-messages': 's',
        regexp: 'e',
        file: 'f',
      },
      shortAliases: { R: 'r' },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    const opts = {
      fixed: parsed.flags.has('F'),
      basic: parsed.flags.has('G'),
      ignoreCase: parsed.flags.has('i'),
      invert: parsed.flags.has('v'),
      word: parsed.flags.has('w'),
      line: parsed.flags.has('x'),
      count: parsed.flags.has('c'),
      filesWithMatches: parsed.flags.has('l'),
      filesWithoutMatches: parsed.flags.has('L'),
      lineNumbers: parsed.flags.has('n'),
      withFilename: parsed.flags.has('H'),
      noFilename: parsed.flags.has('h'),
      onlyMatching: parsed.flags.has('o'),
      quiet: parsed.flags.has('q'),
      recursive: parsed.flags.has('r'),
      suppressErrors: parsed.flags.has('s'),
      after: parseIntOr(parsed.values.get('A'), 0),
      before: parseIntOr(parsed.values.get('B'), 0),
      context: parseIntOr(parsed.values.get('C'), 0),
      include: parsed.values.get('include'),
      exclude: parsed.values.get('exclude'),
      excludeDir: parsed.values.get('exclude-dir'),
    };

    if (opts.context > 0) {
      if (opts.after === 0) opts.after = opts.context;
      if (opts.before === 0) opts.before = opts.context;
    }

    // Collect patterns
    const patterns: string[] = [];
    // -e may be repeated; we only get the last value via parseOptions.
    // Rebuild by scanning args for multiple -e occurrences.
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-e' || a === '--regexp') {
        if (i + 1 < args.length) patterns.push(args[++i]);
      } else if (a.startsWith('--regexp=')) {
        patterns.push(a.slice('--regexp='.length));
      } else if (a.startsWith('-e') && a.length > 2) {
        patterns.push(a.slice(2));
      }
    }
    // Read patterns from -f files
    const fFile = parsed.values.get('f');
    if (fFile) {
      try {
        const content = await this.fs.readFile(resolvePath(fFile, cwd), 'utf8');
        patterns.push(...content.split('\n').filter((l) => l.length > 0));
      } catch (error) {
        return createErrorResult(`${this.name}: ${fFile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    let operands = parsed.operands;
    if (patterns.length === 0) {
      if (operands.length === 0) {
        return createErrorResult(`${this.name}: missing pattern`);
      }
      patterns.push(operands[0]);
      operands = operands.slice(1);
    }

    // Build regex from patterns.
    let regex: RegExp;
    try {
      regex = buildRegex(patterns, {
        fixed: opts.fixed,
        basic: opts.basic,
        ignoreCase: opts.ignoreCase,
        word: opts.word,
        line: opts.line,
      });
    } catch (error) {
      return createErrorResult(`${this.name}: ${error instanceof Error ? error.message : 'invalid pattern'}`);
    }

    const files = operands.length > 0 ? operands : ['-'];
    const outputs: string[] = [];
    let totalMatches = 0;
    let anyMatched = false;

    const showFilename = opts.withFilename || (!opts.noFilename && (files.length > 1 || opts.recursive));

    for (const filePath of files) {
      if (filePath === '-') {
        const content = input ?? '';
        const fileResult = searchContent(content, regex, opts, '(standard input)', showFilename);
        if (fileResult.matched) anyMatched = true;
        totalMatches += fileResult.matchCount;
        appendFileResult(outputs, fileResult, opts);
        continue;
      }

      try {
        const absolutePath = resolvePath(filePath, cwd);
        const stats = await this.fs.stat(absolutePath);

        if (stats.isDirectory()) {
          if (opts.recursive) {
            await this.searchDirectory(absolutePath, filePath, regex, opts, outputs, (r) => {
              if (r.matched) anyMatched = true;
              totalMatches += r.matchCount;
            });
          } else {
            if (!opts.suppressErrors) {
              return createErrorResult(`${this.name}: ${filePath}: Is a directory`);
            }
          }
          continue;
        }

        const content = await this.fs.readFile(absolutePath, 'utf8');
        const fileResult = searchContent(content, regex, opts, filePath, showFilename);
        if (fileResult.matched) anyMatched = true;
        totalMatches += fileResult.matchCount;
        appendFileResult(outputs, fileResult, opts);
      } catch (error) {
        if (opts.suppressErrors) continue;
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

    if (opts.quiet) {
      return { exitCode: anyMatched ? 0 : 1, stdout: '', stderr: '' };
    }

    const stdout = outputs.length > 0 ? outputs.join('\n') + '\n' : '';
    const exitCode = anyMatched ? 0 : 1;

    // Use totalMatches to avoid unused-var warnings in some paths.
    void totalMatches;

    return { exitCode, stdout, stderr: '' };
  }

  private async searchDirectory(
    absPath: string,
    displayPath: string,
    regex: RegExp,
    opts: GrepOptions,
    outputs: string[],
    accumulate: (r: SearchResult) => void,
  ): Promise<void> {
    let entries;
    try {
      entries = await this.fs.readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (opts.excludeDir && matchGlob(entry.name, opts.excludeDir)) continue;
        await this.searchDirectory(
          join(absPath, entry.name),
          `${displayPath}/${entry.name}`,
          regex,
          opts,
          outputs,
          accumulate,
        );
        continue;
      }
      if (opts.exclude && matchGlob(entry.name, opts.exclude)) continue;
      if (opts.include && !matchGlob(entry.name, opts.include)) continue;
      try {
        const content = await this.fs.readFile(join(absPath, entry.name), 'utf8');
        const r = searchContent(content, regex, opts, `${displayPath}/${entry.name}`, true);
        accumulate(r);
        appendFileResult(outputs, r, opts);
      } catch {
        // Non-text or unreadable — skip silently, matching GNU grep -r behavior.
      }
    }
  }
}

interface GrepOptions {
  fixed: boolean;
  basic: boolean;
  ignoreCase: boolean;
  invert: boolean;
  word: boolean;
  line: boolean;
  count: boolean;
  filesWithMatches: boolean;
  filesWithoutMatches: boolean;
  lineNumbers: boolean;
  withFilename: boolean;
  noFilename: boolean;
  onlyMatching: boolean;
  quiet: boolean;
  recursive: boolean;
  suppressErrors: boolean;
  after: number;
  before: number;
  context: number;
  include?: string;
  exclude?: string;
  excludeDir?: string;
}

interface SearchResult {
  filename: string;
  showFilename: boolean;
  matched: boolean;
  matchCount: number;
  lines: string[];
}

function searchContent(
  content: string,
  regex: RegExp,
  opts: GrepOptions,
  filename: string,
  showFilename: boolean,
): SearchResult {
  const allLines = content.split('\n');
  // Drop trailing empty line when content ends with newline, to avoid
  // counting a phantom match at EOF.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '' && content.endsWith('\n')) {
    allLines.pop();
  }

  const matchedIdx = new Set<number>();
  for (let i = 0; i < allLines.length; i++) {
    regex.lastIndex = 0;
    const m = regex.test(allLines[i]);
    if (m !== opts.invert) matchedIdx.add(i);
  }

  const outLines: string[] = [];
  const printed = new Set<number>();
  const matchCount = matchedIdx.size;

  for (let i = 0; i < allLines.length; i++) {
    if (!matchedIdx.has(i)) continue;
    const from = Math.max(0, i - opts.before);
    const to = Math.min(allLines.length - 1, i + opts.after);
    for (let j = from; j <= to; j++) {
      if (printed.has(j)) continue;
      printed.add(j);
      const isMatch = matchedIdx.has(j);
      outLines.push(formatLine(allLines[j], j + 1, isMatch, filename, showFilename, opts, regex));
    }
  }

  return {
    filename,
    showFilename,
    matched: matchCount > 0,
    matchCount,
    lines: outLines,
  };
}

function formatLine(
  line: string,
  lineNum: number,
  isMatchLine: boolean,
  filename: string,
  showFilename: boolean,
  opts: GrepOptions,
  regex: RegExp,
): string {
  const sep = isMatchLine ? ':' : '-';
  const prefix = [
    showFilename ? filename : null,
    opts.lineNumbers ? String(lineNum) : null,
  ].filter((x) => x !== null).join(sep);

  if (opts.onlyMatching && isMatchLine) {
    regex.lastIndex = 0;
    const matches: string[] = [];
    const globalRe = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(line)) !== null) {
      matches.push(m[0]);
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
    }
    return matches.map((match) => (prefix ? `${prefix}${sep}${match}` : match)).join('\n');
  }

  return prefix ? `${prefix}${sep}${line}` : line;
}

function appendFileResult(outputs: string[], r: SearchResult, opts: GrepOptions): void {
  if (opts.filesWithMatches) {
    if (r.matched) outputs.push(r.filename);
    return;
  }
  if (opts.filesWithoutMatches) {
    if (!r.matched) outputs.push(r.filename);
    return;
  }
  if (opts.count) {
    outputs.push(r.showFilename ? `${r.filename}:${r.matchCount}` : String(r.matchCount));
    return;
  }
  outputs.push(...r.lines);
}

function buildRegex(
  patterns: string[],
  opts: { fixed: boolean; basic: boolean; ignoreCase: boolean; word: boolean; line: boolean },
): RegExp {
  const sources: string[] = patterns.flatMap((p) =>
    // POSIX grep treats newline in -e pattern as alternation.
    p.split('\n').filter((s) => s.length > 0),
  );
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const srcs = sources.map((src) => {
    if (opts.fixed) return escape(src);
    if (opts.basic) return convertBreToEre(src);
    return src;
  });

  let source = srcs.length === 1 ? srcs[0] : `(?:${srcs.join('|')})`;

  if (opts.word) source = `(?:^|[^\\w])(?:${source})(?=$|[^\\w])`;
  if (opts.line) source = `^(?:${source})$`;

  const flags = opts.ignoreCase ? 'i' : '';
  return new RegExp(source, flags);
}

/** Convert BRE metachars \(, \), \{, \}, \|, \+, \? to ERE equivalents. */
function convertBreToEre(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1];
      if (n === '(' || n === ')' || n === '{' || n === '}' || n === '|' || n === '+' || n === '?') {
        out += n;
        i += 2;
        continue;
      }
      out += c + n;
      i += 2;
      continue;
    }
    // In BRE, these are literal: ( ) { } | + ?
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '|' || c === '+' || c === '?') {
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function parseIntOr(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

/** Simple glob matcher (supports *, ?, [...]). */
function matchGlob(name: string, pattern: string): boolean {
  const re = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    + '$'
  );
  return re.test(name);
}
