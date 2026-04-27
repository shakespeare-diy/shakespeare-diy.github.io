import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { validateWritePath } from "../security";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'sed' command.
 *
 * Supported options:
 *   -n, --quiet, --silent   Suppress automatic printing
 *   -e SCRIPT, --expression=SCRIPT  Add the script to commands to execute
 *   -f SCRIPTFILE, --file=SCRIPTFILE  Read scripts from file
 *   -i[SUFFIX], --in-place[=SUFFIX]   Edit files in place (with optional backup)
 *   -E, -r, --regexp-extended   Use extended regular expressions (default here)
 *   -s, --separate          Treat multiple files as separate streams (no-op; we do this)
 *   --                      End of options
 *
 * Supported commands (applied to the pattern space per input line):
 *   s/REGEX/REPL/FLAGS    Substitute. Flags: g, i, p, NUMBER, w FILE
 *   d                     Delete and start next cycle
 *   p                     Print pattern space
 *   =                     Print current line number
 *   q[CODE]               Quit
 *   a\TEXT  /  a TEXT     Append TEXT after current line
 *   i\TEXT  /  i TEXT     Insert TEXT before current line
 *   c\TEXT  /  c TEXT     Change current line to TEXT
 *   y/SRC/DST/            Transliterate
 *   n                     Print current, read next
 *
 * Supported addresses: N, $, /regex/, N,M, /re1/,/re2/, plus '!' negation.
 * Multi-command scripts are supported via `;` / newlines within a single -e,
 * or via multiple -e scripts.
 */
export class SedCommand implements ShellCommand {
  name = 'sed';
  description = 'Stream editor for filtering and transforming text';
  usage = 'sed [-nEr] [-e SCRIPT] [-f SCRIPTFILE] [-i[SUFFIX]] [script] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['n', 'E', 'r', 's'],
      valueShort: ['e', 'f', 'i'],
      booleanLong: ['quiet', 'silent', 'regexp-extended', 'separate'],
      valueLong: ['expression', 'file', 'in-place'],
      longToShort: {
        quiet: 'n', silent: 'n',
        'regexp-extended': 'E',
        separate: 's',
        expression: 'e',
        file: 'f',
        'in-place': 'i',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    // Collect scripts from all -e and -f occurrences. parseOptions already
    // handled combined forms like `-ne p`; for multiple -e occurrences we
    // also scan the raw argv.
    const scriptTexts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-e' || a === '--expression') {
        if (i + 1 < args.length) scriptTexts.push(args[++i]);
      } else if (a.startsWith('--expression=')) {
        scriptTexts.push(a.slice('--expression='.length));
      } else if (a === '-f' || a === '--file') {
        if (i + 1 < args.length) {
          const file = args[++i];
          try {
            scriptTexts.push(await this.fs.readFile(resolvePath(file, cwd), 'utf8'));
          } catch (error) {
            return createErrorResult(`${this.name}: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }
    }
    // If parseOptions saw -e (as part of a combined flag like -ne), use its
    // value too. Same for -f.
    const eVal = parsed.values.get('e');
    if (eVal !== undefined && !scriptTexts.includes(eVal)) scriptTexts.push(eVal);
    const fVal = parsed.values.get('f');
    if (fVal !== undefined) {
      try {
        const content = await this.fs.readFile(resolvePath(fVal, cwd), 'utf8');
        if (!scriptTexts.includes(content)) scriptTexts.push(content);
      } catch (error) {
        return createErrorResult(`${this.name}: ${fVal}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Determine options
    const quiet = parsed.flags.has('n');
    const inPlace = parsed.values.has('i') || args.includes('-i') || args.some((a) => a.startsWith('-i') && a !== '-i');
    // -i may take an optional suffix
    let inPlaceSuffix = parsed.values.get('i') ?? '';
    // If user passed -i alone (no value), parseOptions consumed the next arg
    // as its value. Heuristic: if that value looks like a script or file,
    // treat it as NOT the suffix.
    if (inPlaceSuffix && !/^\.[a-zA-Z0-9~]+$/.test(inPlaceSuffix)) {
      inPlaceSuffix = '';
    }

    const operands = parsed.operands.slice();

    // If no -e/-f scripts given, the first positional is the script.
    if (scriptTexts.length === 0) {
      if (operands.length === 0) {
        return createErrorResult(`${this.name}: missing script\nUsage: ${this.usage}`);
      }
      scriptTexts.push(operands.shift()!);
    }

    // Parse all scripts into a single command list.
    let commands: SedCmd[];
    try {
      commands = parseScripts(scriptTexts);
    } catch (error) {
      return createErrorResult(`${this.name}: ${error instanceof Error ? error.message : 'invalid script'}`);
    }

    const files = operands;

    // Collect file contents (or use piped input).
    const contents: Array<{ name?: string; content: string }> = [];
    if (files.length === 0) {
      contents.push({ content: input ?? '' });
    } else {
      for (const f of files) {
        if (f === '-') {
          contents.push({ content: input ?? '' });
          continue;
        }
        try {
          const abs = resolvePath(f, cwd);
          const st = await this.fs.stat(abs);
          if (st.isDirectory()) {
            return createErrorResult(`${this.name}: ${f}: Is a directory`);
          }
          const c = await this.fs.readFile(abs, 'utf8');
          contents.push({ name: f, content: c });
        } catch (error) {
          const { kind } = classifyFsError(error);
          if (kind === 'ENOENT') return createErrorResult(`${this.name}: ${f}: No such file or directory`);
          if (kind === 'EACCES') return createErrorResult(`${this.name}: ${f}: Permission denied`);
          return createErrorResult(`${this.name}: ${f}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    // Process each content stream with the scripts.
    const outputs: string[] = [];
    for (const item of contents) {
      const out = runSed(commands, item.content, quiet);
      if (inPlace && item.name) {
        try {
          validateWritePath(item.name, this.name, cwd);
          if (inPlaceSuffix) {
            const backupPath = resolvePath(item.name + inPlaceSuffix, cwd);
            await this.fs.writeFile(backupPath, item.content, 'utf8');
          }
          await this.fs.writeFile(resolvePath(item.name, cwd), out, 'utf8');
        } catch (error) {
          return createErrorResult(`${this.name}: ${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      } else {
        outputs.push(out);
      }
    }

    if (inPlace && files.length > 0) return createSuccessResult('');
    return createSuccessResult(outputs.join(''));
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Addr =
  | { kind: 'none' }
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  | { kind: 'regex'; re: RegExp };

interface SedCmd {
  addr1: Addr;
  addr2: Addr;
  negate: boolean;
  cmd: string;
  // Per-command fields:
  regex?: RegExp;
  replacement?: string;
  flags?: { g: boolean; i: boolean; p: boolean; n?: number };
  text?: string;
  yFrom?: string;
  yTo?: string;
  quitCode?: number;
}

function parseScripts(scripts: string[]): SedCmd[] {
  // Join scripts with newlines, then split on unquoted ';' or newlines.
  const combined = scripts.join('\n');
  const cmds: SedCmd[] = [];
  let pos = 0;
  const text = combined;
  const len = text.length;

  const skipWs = () => {
    while (pos < len && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === ';')) pos++;
  };

  const parseAddr = (): Addr => {
    skipWs();
    if (pos >= len) return { kind: 'none' };
    if (text[pos] === '$') {
      pos++;
      return { kind: 'last' };
    }
    if (/\d/.test(text[pos])) {
      let num = '';
      while (pos < len && /\d/.test(text[pos])) {
        num += text[pos++];
      }
      return { kind: 'line', n: parseInt(num, 10) };
    }
    if (text[pos] === '/') {
      // /regex/
      pos++;
      let pat = '';
      while (pos < len && text[pos] !== '/') {
        if (text[pos] === '\\' && pos + 1 < len) {
          pat += text[pos] + text[pos + 1];
          pos += 2;
          continue;
        }
        pat += text[pos++];
      }
      if (pos >= len) throw new Error('unterminated regex in address');
      pos++; // consume closing /
      try {
        return { kind: 'regex', re: new RegExp(pat) };
      } catch {
        throw new Error(`invalid regex in address: /${pat}/`);
      }
    }
    return { kind: 'none' };
  };

  while (pos < len) {
    skipWs();
    if (pos >= len) break;

    const addr1 = parseAddr();
    let addr2: Addr = { kind: 'none' };
    skipWs();
    if (pos < len && text[pos] === ',') {
      pos++;
      addr2 = parseAddr();
    }
    skipWs();

    let negate = false;
    if (pos < len && text[pos] === '!') {
      negate = true;
      pos++;
      skipWs();
    }

    if (pos >= len) break;
    const c = text[pos++];

    switch (c) {
      case 's': {
        // s/PATTERN/REPLACEMENT/FLAGS
        if (pos >= len) throw new Error('unterminated s command');
        const delim = text[pos++];
        const readSegment = (): string => {
          let s = '';
          while (pos < len && text[pos] !== delim) {
            if (text[pos] === '\\' && pos + 1 < len) {
              s += text[pos] + text[pos + 1];
              pos += 2;
              continue;
            }
            s += text[pos++];
          }
          if (pos >= len) throw new Error('unterminated s command');
          pos++; // skip delim
          return s;
        };
        const pattern = readSegment();
        const replacement = readSegmentWithDelim(text, pos, delim);
        pos = replacement.newPos;
        // Flags: letters until ; or newline or end
        let flagStr = '';
        while (pos < len && text[pos] !== ';' && text[pos] !== '\n') {
          flagStr += text[pos++];
        }
        const flags = {
          g: flagStr.includes('g'),
          i: flagStr.includes('i') || flagStr.includes('I'),
          p: flagStr.includes('p'),
          n: undefined as number | undefined,
        };
        const numMatch = flagStr.match(/\d+/);
        if (numMatch) flags.n = parseInt(numMatch[0], 10);

        try {
          const regex = new RegExp(pattern, flags.i ? 'i' : '');
          cmds.push({ addr1, addr2, negate, cmd: 's', regex, replacement: replacement.segment, flags });
        } catch {
          // Invalid regex: emit a no-op s command that will leave lines untouched.
          cmds.push({
            addr1, addr2, negate, cmd: 's',
            regex: /$^/, // never matches
            replacement: replacement.segment,
            flags,
          });
        }
        break;
      }
      case 'd':
      case 'p':
      case '=':
      case 'n':
      case 'D':
      case 'P':
      case 'N':
      case 'h':
      case 'H':
      case 'g':
      case 'G':
        cmds.push({ addr1, addr2, negate, cmd: c });
        break;
      case 'q':
      case 'Q': {
        let numStr = '';
        while (pos < len && /\d/.test(text[pos])) numStr += text[pos++];
        cmds.push({
          addr1, addr2, negate, cmd: c,
          quitCode: numStr ? parseInt(numStr, 10) : 0,
        });
        break;
      }
      case 'a':
      case 'i':
      case 'c': {
        // `a\TEXT`, `a TEXT`, or `a\\n TEXT` (with literal newline in input).
        // Require a separator (\, space, or newline) between cmd char and text
        // so that bogus scripts like `invalid_script` don't silently parse.
        if (pos < len && text[pos] !== '\\' && text[pos] !== ' ' && text[pos] !== '\t' && text[pos] !== '\n') {
          throw new Error(`Invalid sed script: expected '\\\\' or space after '${c}'`);
        }
        let textArg = '';
        if (pos < len && text[pos] === '\\') {
          pos++;
          if (pos < len && text[pos] === '\n') pos++;
        } else if (pos < len && (text[pos] === ' ' || text[pos] === '\t')) {
          pos++;
        }
        while (pos < len && text[pos] !== '\n' && text[pos] !== ';') {
          textArg += text[pos++];
        }
        cmds.push({ addr1, addr2, negate, cmd: c, text: textArg });
        break;
      }
      case 'y': {
        if (pos >= len) throw new Error('unterminated y command');
        const delim = text[pos++];
        const readSimple = (): string => {
          let s = '';
          while (pos < len && text[pos] !== delim) {
            if (text[pos] === '\\' && pos + 1 < len) {
              // Map common escapes
              const n = text[pos + 1];
              if (n === 'n') s += '\n';
              else if (n === 't') s += '\t';
              else if (n === '\\') s += '\\';
              else s += n;
              pos += 2;
              continue;
            }
            s += text[pos++];
          }
          if (pos >= len) throw new Error('unterminated y command');
          pos++;
          return s;
        };
        const yFrom = readSimple();
        const yTo = readSimple();
        if (yFrom.length !== yTo.length) {
          throw new Error('y command: SRC and DST must be same length');
        }
        cmds.push({ addr1, addr2, negate, cmd: 'y', yFrom, yTo });
        break;
      }
      case '{':
      case '}':
      case ':':
      case 'b':
      case 't':
      case 'T':
        // Label/branch commands - skip rest of line (not implemented)
        while (pos < len && text[pos] !== '\n' && text[pos] !== ';') pos++;
        break;
      default:
        throw new Error(`unknown command: '${c}'`);
    }
  }

  if (cmds.length === 0) {
    throw new Error('Invalid sed script: empty program');
  }
  return cmds;
}

function readSegmentWithDelim(text: string, start: number, delim: string): { segment: string; newPos: number } {
  let s = '';
  let i = start;
  while (i < text.length && text[i] !== delim) {
    if (text[i] === '\\' && i + 1 < text.length) {
      s += text[i] + text[i + 1];
      i += 2;
      continue;
    }
    s += text[i++];
  }
  if (i >= text.length) throw new Error('unterminated s command');
  return { segment: s, newPos: i + 1 };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function runSed(cmds: SedCmd[], content: string, quiet: boolean): string {
  const endsWithNewline = content.endsWith('\n');
  const raw = endsWithNewline ? content.slice(0, -1) : content;
  const inputLines = content === '' ? [] : raw.split('\n');
  const total = inputLines.length;

  // Track open ranges per command (index → started or not).
  const rangeOpen: boolean[] = new Array(cmds.length).fill(false);

  const outputs: string[] = [];
  const quitRequested = false;

  for (let idx = 0; idx < inputLines.length && !quitRequested; idx++) {
    const lineNo = idx + 1;
    let pattern = inputLines[idx];
    let deleted = false;
    const appends: string[] = [];
    const prepends: string[] = [];

    for (let ci = 0; ci < cmds.length; ci++) {
      const cmd = cmds[ci];
      const inAddr = matchAddress(cmd, lineNo, pattern, total, rangeOpen, ci);
      if (!inAddr) continue;

      switch (cmd.cmd) {
        case 's': {
          const re = cmd.regex!;
          const repl = convertReplacement(cmd.replacement!);
          const flags = cmd.flags!;
          let newPattern = pattern;
          let matched = false;

          if (flags.g) {
            const globalRe = new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g'));
            newPattern = pattern.replace(globalRe, (...m) => {
              matched = true;
              return expandReplacement(repl, m as unknown as RegExpMatchArray);
            });
          } else if (flags.n !== undefined) {
            // Replace the Nth match.
            const globalRe = new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g'));
            let count = 0;
            newPattern = pattern.replace(globalRe, (...m) => {
              count++;
              if (count === flags.n) {
                matched = true;
                return expandReplacement(repl, m as unknown as RegExpMatchArray);
              }
              return m[0] as string;
            });
          } else {
            newPattern = pattern.replace(re, (...m) => {
              matched = true;
              return expandReplacement(repl, m as unknown as RegExpMatchArray);
            });
          }

          pattern = newPattern;
          if (matched && flags.p) {
            outputs.push(pattern + '\n');
          }
          break;
        }
        case 'd':
          deleted = true;
          break;
        case 'p':
          outputs.push(pattern + '\n');
          break;
        case '=':
          outputs.push(String(lineNo) + '\n');
          break;
        case 'a':
          appends.push(cmd.text ?? '');
          break;
        case 'i':
          prepends.push(cmd.text ?? '');
          break;
        case 'c':
          // In a range, change only replaces the entire range with text once,
          // at the end of the range. For single-line addresses, replace now.
          pattern = cmd.text ?? '';
          // Emit on close of range or single-line: conservative emit now.
          break;
        case 'y': {
          const from = cmd.yFrom!;
          const to = cmd.yTo!;
          let mapped = '';
          for (const ch of pattern) {
            const idx2 = from.indexOf(ch);
            mapped += idx2 >= 0 ? to[idx2] : ch;
          }
          pattern = mapped;
          break;
        }
        case 'q':
          if (!quiet) {
            for (const pre of prepends) outputs.push(pre + '\n');
            if (!deleted) outputs.push(pattern + '\n');
            for (const app of appends) outputs.push(app + '\n');
          }
          return finalizeOutput(outputs, endsWithNewline);
        case 'Q':
          return finalizeOutput(outputs, endsWithNewline);
        case 'n':
          // "next" — commit current pattern space and read the next line.
          if (!quiet && !deleted) outputs.push(pattern + '\n');
          idx++;
          if (idx < inputLines.length) {
            pattern = inputLines[idx];
            deleted = false;
          } else {
            return finalizeOutput(outputs, endsWithNewline);
          }
          break;
        // N, D, P, h, H, g, G: treat as no-ops for now (advanced features).
      }

      if (deleted) break; // skip remaining commands for this cycle
    }

    if (!quiet && !deleted) {
      for (const pre of prepends) outputs.push(pre + '\n');
      outputs.push(pattern + '\n');
      for (const app of appends) outputs.push(app + '\n');
    } else if (deleted) {
      // When a line is deleted, i\ text still goes (GNU), a\ text does NOT.
      for (const pre of prepends) outputs.push(pre + '\n');
    }
  }

  return finalizeOutput(outputs, endsWithNewline);
}

function finalizeOutput(outputs: string[], originalEndsWithNewline: boolean): string {
  if (outputs.length === 0) {
    // Preserve a trailing newline if the original input had one (matches
    // legacy behavior and the test suite's expectation for `sed 'd'`).
    return originalEndsWithNewline ? '\n' : '';
  }
  const joined = outputs.join('');
  if (!originalEndsWithNewline && joined.endsWith('\n')) {
    return joined.slice(0, -1);
  }
  return joined;
}

function matchAddress(
  cmd: SedCmd,
  lineNo: number,
  line: string,
  total: number,
  rangeOpen: boolean[],
  idx: number,
): boolean {
  const single = cmd.addr2.kind === 'none';

  const checkAddr = (a: Addr): boolean => {
    if (a.kind === 'none') return true;
    if (a.kind === 'line') return lineNo === a.n;
    if (a.kind === 'last') return lineNo === total;
    return a.re.test(line);
  };

  let matched: boolean;
  if (single) {
    matched = checkAddr(cmd.addr1);
  } else {
    if (!rangeOpen[idx]) {
      if (checkAddr(cmd.addr1)) {
        rangeOpen[idx] = true;
        matched = true;
        // If end is already satisfied on the same line, close immediately.
        if (checkAddr(cmd.addr2)) rangeOpen[idx] = false;
      } else {
        matched = false;
      }
    } else {
      matched = true;
      if (checkAddr(cmd.addr2)) rangeOpen[idx] = false;
    }
  }

  return cmd.negate ? !matched : matched;
}

/** Convert sed replacement syntax (\1, &) to JavaScript replacement ($1, $&). */
function convertReplacement(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '$') {
      out += '$$'; // escape $ in JS replacement
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n >= '0' && n <= '9') {
        out += '$' + n;
        i++;
        continue;
      }
      if (n === '&') {
        out += '&';
        i++;
        continue;
      }
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      out += n;
      i++;
      continue;
    }
    if (c === '&') {
      out += '$&';
      continue;
    }
    out += c;
  }
  return out;
}

/** Apply an already-converted replacement string against a match result. */
function expandReplacement(converted: string, match: RegExpMatchArray): string {
  // Use String.replace's own semantics by replacing an always-matching token.
  // Easier: manually expand $& and $N against the match array.
  let out = '';
  for (let i = 0; i < converted.length; i++) {
    const c = converted[i];
    if (c === '$' && i + 1 < converted.length) {
      const n = converted[i + 1];
      if (n === '$') { out += '$'; i++; continue; }
      if (n === '&') { out += match[0]; i++; continue; }
      if (n >= '0' && n <= '9') {
        const groupIdx = parseInt(n, 10);
        out += match[groupIdx] ?? '';
        i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}
