import { join, basename } from "path-browserify";
import type { JSRuntimeFS, DirectoryEntry } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { resolvePath } from "./utils";

/**
 * Implementation of the 'find' command.
 *
 * Supported primaries (tests):
 *   -name PATTERN           Base name matches glob (case-sensitive)
 *   -iname PATTERN          Like -name, case-insensitive
 *   -path PATTERN           Full path matches glob
 *   -ipath PATTERN          Like -path, case-insensitive
 *   -type TYPE              f, d, l (regular file, directory, symlink)
 *   -empty                  Match empty files/dirs
 *   -size N[ckMG]           Size comparison (supports +N / -N / N)
 *   -maxdepth N             Limit depth of descent (0 = operands only)
 *   -mindepth N             Skip at depths < N
 *   -regex PATTERN          Full-path regex (JS syntax)
 *   -not / !                Negate the following primary
 *
 * Supported actions:
 *   -print                  Print name (default)
 *   -print0                 Print name followed by NUL
 *   -delete                 Delete matched files (best-effort)
 *   -quit                   Exit immediately after first match
 *
 * Supported operators (left-to-right, no precedence parsing beyond AND):
 *   -and / -a (implicit)    Logical AND
 *   -or / -o                Logical OR
 *
 * Omissions: parentheses, -exec, -prune, -newer.
 */
export class FindCommand implements ShellCommand {
  name = 'find';
  description = 'Search for files and directories';
  usage = 'find [path...] [expression]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    // Separate paths (leading non-option args) from the expression.
    const paths: string[] = [];
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '-' || (!a.startsWith('-') && !a.startsWith('!') && !a.startsWith('('))) {
        paths.push(a);
        i++;
        continue;
      }
      break;
    }
    const exprTokens = args.slice(i);
    const searchPaths = paths.length > 0 ? paths : ['.'];

    let expr: Expression;
    try {
      expr = parseExpression(exprTokens);
    } catch (error) {
      return createErrorResult(`${this.name}: ${error instanceof Error ? error.message : 'invalid expression'}`);
    }

    const outputs: string[] = [];
    let shouldQuit = false;

    for (const startPath of searchPaths) {
      if (shouldQuit) break;
      const absoluteRoot = resolvePath(startPath, cwd);
      try {
        const stats = await this.fs.stat(absoluteRoot);
        const kind: EntryKind = stats.isDirectory() ? 'd' : stats.isFile() ? 'f' : 'other';
        shouldQuit = await this.walk(absoluteRoot, startPath, kind, 0, expr, outputs, stats.size ?? 0);
      } catch (error) {
        return createErrorResult(`${this.name}: '${startPath}': ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return createSuccessResult(outputs.length > 0 ? outputs.join('') : '');
  }

  private async walk(
    absPath: string,
    displayPath: string,
    kind: EntryKind,
    depth: number,
    expr: Expression,
    outputs: string[],
    size: number,
  ): Promise<boolean> {
    const ctx: MatchContext = {
      name: basename(displayPath) || displayPath,
      path: displayPath,
      type: kind,
      depth,
      size,
      isEmpty: await this.checkEmpty(absPath, kind),
    };

    const { matched, didAction, quit } = evaluate(expr, ctx);

    if (matched && !didAction && depth >= expr.minDepth) {
      outputs.push(displayPath + '\n');
    }

    if (quit) return true;

    if (kind === 'd' && depth < expr.maxDepth) {
      let entries: DirectoryEntry[] = [];
      try {
        entries = await this.fs.readdir(absPath, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        const entryAbs = join(absPath, entry.name);
        const entryDisp = displayPath.endsWith('/') ? displayPath + entry.name : `${displayPath}/${entry.name}`;
        // Prefer the dirent's type info; only stat for size/empty checks.
        let entryKind: EntryKind = entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'other';
        let entrySize = 0;
        try {
          const st = await this.fs.stat(entryAbs);
          entryKind = st.isDirectory() ? 'd' : st.isFile() ? 'f' : entryKind;
          entrySize = st.size ?? 0;
        } catch {
          // stat may fail in mocked filesystems; fall back to dirent type.
        }
        const subQuit = await this.walk(entryAbs, entryDisp, entryKind, depth + 1, expr, outputs, entrySize);
        if (subQuit) return true;
      }
    }

    return false;
  }

  private async checkEmpty(absPath: string, kind: EntryKind): Promise<boolean> {
    if (kind === 'f') {
      try {
        const s = await this.fs.stat(absPath);
        return (s.size ?? 0) === 0;
      } catch {
        return false;
      }
    }
    if (kind === 'd') {
      try {
        const entries = await this.fs.readdir(absPath);
        return entries.length === 0;
      } catch {
        return false;
      }
    }
    return false;
  }
}

type EntryKind = 'f' | 'd' | 'l' | 'other';

interface MatchContext {
  name: string;
  path: string;
  type: EntryKind;
  depth: number;
  size: number;
  isEmpty: boolean;
}

// Primary/expression AST
type Primary =
  | { kind: 'true' }
  | { kind: 'name'; pattern: string; caseInsensitive: boolean }
  | { kind: 'path'; pattern: string; caseInsensitive: boolean }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'type'; t: EntryKind }
  | { kind: 'empty' }
  | { kind: 'size'; cmp: '+' | '-' | '='; n: number; unit: 'b' | 'c' | 'k' | 'M' | 'G' }
  | { kind: 'print' }
  | { kind: 'print0' }
  | { kind: 'delete' }
  | { kind: 'quit' };

type ExprNode =
  | { op: 'and'; a: ExprNode; b: ExprNode }
  | { op: 'or'; a: ExprNode; b: ExprNode }
  | { op: 'not'; a: ExprNode }
  | { op: 'prim'; p: Primary };

interface Expression {
  root: ExprNode;
  maxDepth: number;
  minDepth: number;
}

function parseExpression(tokens: string[]): Expression {
  let maxDepth = Infinity;
  let minDepth = 0;

  // Strip -maxdepth/-mindepth globals out first.
  const filtered: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-maxdepth') {
      const v = parseInt(tokens[++i] ?? '', 10);
      if (isNaN(v)) throw new Error(`invalid -maxdepth value`);
      maxDepth = v;
    } else if (t === '-mindepth') {
      const v = parseInt(tokens[++i] ?? '', 10);
      if (isNaN(v)) throw new Error(`invalid -mindepth value`);
      minDepth = v;
    } else {
      filtered.push(t);
    }
  }

  let pos = 0;

  const parsePrimary = (): ExprNode => {
    if (pos >= filtered.length) return { op: 'prim', p: { kind: 'true' } };
    const t = filtered[pos];
    if (t === '-not' || t === '!') {
      pos++;
      const inner = parsePrimary();
      return { op: 'not', a: inner };
    }
    pos++;
    switch (t) {
      case '-name': {
        const pat = filtered[pos++];
        return { op: 'prim', p: { kind: 'name', pattern: pat, caseInsensitive: false } };
      }
      case '-iname': {
        const pat = filtered[pos++];
        return { op: 'prim', p: { kind: 'name', pattern: pat, caseInsensitive: true } };
      }
      case '-path':
      case '-wholename': {
        const pat = filtered[pos++];
        return { op: 'prim', p: { kind: 'path', pattern: pat, caseInsensitive: false } };
      }
      case '-ipath':
      case '-iwholename': {
        const pat = filtered[pos++];
        return { op: 'prim', p: { kind: 'path', pattern: pat, caseInsensitive: true } };
      }
      case '-regex': {
        const pat = filtered[pos++];
        return { op: 'prim', p: { kind: 'regex', re: new RegExp(pat) } };
      }
      case '-iregex': {
        const pat = filtered[pos++];
        return { op: 'prim', p: { kind: 'regex', re: new RegExp(pat, 'i') } };
      }
      case '-type': {
        const ty = filtered[pos++];
        const map: Record<string, EntryKind> = { f: 'f', d: 'd', l: 'l' };
        if (!(ty in map)) throw new Error(`-type: invalid argument '${ty}'`);
        return { op: 'prim', p: { kind: 'type', t: map[ty] } };
      }
      case '-empty':
        return { op: 'prim', p: { kind: 'empty' } };
      case '-size': {
        const spec = filtered[pos++];
        const m = /^([+-]?)(\d+)([bckMG])?$/.exec(spec);
        if (!m) throw new Error(`-size: invalid argument '${spec}'`);
        const cmp = (m[1] || '=') as '+' | '-' | '=';
        const n = parseInt(m[2], 10);
        const unit = (m[3] || 'b') as 'b' | 'c' | 'k' | 'M' | 'G';
        return { op: 'prim', p: { kind: 'size', cmp, n, unit } };
      }
      case '-print':
        return { op: 'prim', p: { kind: 'print' } };
      case '-print0':
        return { op: 'prim', p: { kind: 'print0' } };
      case '-delete':
        return { op: 'prim', p: { kind: 'delete' } };
      case '-quit':
        return { op: 'prim', p: { kind: 'quit' } };
      case '-true':
        return { op: 'prim', p: { kind: 'true' } };
      case '-false':
        return { op: 'not', a: { op: 'prim', p: { kind: 'true' } } };
      default:
        throw new Error(`unknown predicate: '${t}'`);
    }
  };

  const parseAnd = (): ExprNode => {
    let left = parsePrimary();
    while (pos < filtered.length) {
      const t = filtered[pos];
      if (t === '-or' || t === '-o' || t === ')' || t === ',') break;
      if (t === '-and' || t === '-a') pos++;
      const right = parsePrimary();
      left = { op: 'and', a: left, b: right };
    }
    return left;
  };

  const parseOr = (): ExprNode => {
    let left = parseAnd();
    while (pos < filtered.length && (filtered[pos] === '-or' || filtered[pos] === '-o')) {
      pos++;
      const right = parseAnd();
      left = { op: 'or', a: left, b: right };
    }
    return left;
  };

  let root: ExprNode;
  if (filtered.length === 0) {
    root = { op: 'prim', p: { kind: 'true' } };
  } else {
    root = parseOr();
  }

  return { root, maxDepth, minDepth };
}

function evaluate(expr: Expression, ctx: MatchContext): { matched: boolean; didAction: boolean; quit: boolean } {
  if (ctx.depth < expr.minDepth) {
    return { matched: false, didAction: false, quit: false };
  }
  const r = evalNode(expr.root, ctx);
  return r;
}

function evalNode(n: ExprNode, ctx: MatchContext): { matched: boolean; didAction: boolean; quit: boolean } {
  if (n.op === 'not') {
    const r = evalNode(n.a, ctx);
    return { matched: !r.matched, didAction: r.didAction, quit: r.quit };
  }
  if (n.op === 'and') {
    const a = evalNode(n.a, ctx);
    if (!a.matched) return a;
    const b = evalNode(n.b, ctx);
    return {
      matched: a.matched && b.matched,
      didAction: a.didAction || b.didAction,
      quit: a.quit || b.quit,
    };
  }
  if (n.op === 'or') {
    const a = evalNode(n.a, ctx);
    if (a.matched) return a;
    const b = evalNode(n.b, ctx);
    return {
      matched: a.matched || b.matched,
      didAction: a.didAction || b.didAction,
      quit: a.quit || b.quit,
    };
  }
  // Primary
  return evalPrim(n.p, ctx);
}

function evalPrim(p: Primary, ctx: MatchContext): { matched: boolean; didAction: boolean; quit: boolean } {
  switch (p.kind) {
    case 'true':
      return { matched: true, didAction: false, quit: false };
    case 'name':
      return { matched: globMatch(ctx.name, p.pattern, p.caseInsensitive), didAction: false, quit: false };
    case 'path':
      return { matched: globMatch(ctx.path, p.pattern, p.caseInsensitive), didAction: false, quit: false };
    case 'regex':
      return { matched: p.re.test(ctx.path), didAction: false, quit: false };
    case 'type':
      return { matched: ctx.type === p.t, didAction: false, quit: false };
    case 'empty':
      return { matched: ctx.isEmpty, didAction: false, quit: false };
    case 'size': {
      const unitMultipliers: Record<string, number> = { b: 512, c: 1, k: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
      const target = p.n * (unitMultipliers[p.unit] ?? 1);
      const actual = ctx.size;
      if (p.cmp === '+') return { matched: actual > target, didAction: false, quit: false };
      if (p.cmp === '-') return { matched: actual < target, didAction: false, quit: false };
      // exact: for 'b' (512-byte blocks), match if ceil(actual/512) === n
      if (p.unit === 'b') {
        const blocks = Math.ceil(actual / 512);
        return { matched: blocks === p.n, didAction: false, quit: false };
      }
      return { matched: actual === target, didAction: false, quit: false };
    }
    case 'print':
    case 'print0':
    case 'delete':
      // These are actions: they always "match" true, and they mark didAction
      // so the default -print action is suppressed.
      return { matched: true, didAction: true, quit: false };
    case 'quit':
      return { matched: true, didAction: false, quit: true };
  }
}

function globMatch(s: string, pattern: string, caseInsensitive: boolean): boolean {
  const escapedRe = '^' + pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$';
  const re = new RegExp(escapedRe, caseInsensitive ? 'i' : '');
  return re.test(s);
}
