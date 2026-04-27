/**
 * Word expansion.
 *
 * Given a Word (produced by the parser) and a shell environment, produces
 * one or more fully-expanded argument strings. The expansion pipeline
 * follows POSIX ordering:
 *
 *   1. Brace expansion (bash extension): `a{b,c}` → `ab ac`
 *   2. Tilde expansion: `~/foo` → `/home/user/foo`
 *   3. Parameter expansion: `$VAR`, `${VAR}`, `$?`
 *   4. Command substitution: `$(cmd)`, backticks
 *   5. Arithmetic expansion: `$((1+2))`
 *   6. Word splitting (on whitespace) — only for UNQUOTED expanded text
 *   7. Pathname (glob) expansion — only on unquoted words with metacharacters
 *   8. Quote removal
 *
 * Single-quoted text skips steps 2–7 entirely. Double-quoted text allows
 * steps 3–5 but skips splitting and globbing.
 *
 * The caller supplies a `ShellEnv` that the expander consults for
 * variable values, filesystem access, and command substitution.
 */

import type { Word, WordSegment } from './ast';
import type { JSRuntimeFS } from '../JSRuntime';
import { join } from 'path-browserify';

export interface ShellEnv {
  /** Look up a variable (regular or special like `?`, `$`, `#`). Returns empty string for unset. */
  getVar(name: string): string;
  /** Current working directory. */
  getCwd(): string;
  /** Home directory for tilde expansion. */
  getHome(): string;
  /** Run a subshell script (for command substitution). Returns its stdout. */
  runSubshell(script: string): Promise<string>;
  /** Filesystem for glob expansion. */
  getFS(): JSRuntimeFS;
}

/**
 * Expand one Word into 0..n argument strings. May produce:
 *  - 0 strings if the word fully expands to nothing (e.g. unquoted empty var)
 *  - 1 string for ordinary words
 *  - N strings for globs or brace expansions
 */
export async function expandWord(word: Word, env: ShellEnv): Promise<string[]> {
  // Step 1: brace expansion produces raw "pseudo-words" (arrays of segments
  // that then go through the rest of the pipeline).
  const braceExpanded = expandBraces(word);

  const results: string[] = [];
  for (const bw of braceExpanded) {
    // Steps 2–5: expand segments into "text pieces" that track quoting.
    const pieces = await expandSegments(bw, env);
    // Step 6: split unquoted text on IFS whitespace, preserving quoted text.
    const split = splitWords(pieces);
    // Step 7 + 8: glob + quote removal.
    for (const fields of split) {
      const globbed = await maybeGlob(fields, env);
      for (const g of globbed) results.push(g);
    }
  }
  return results;
}

/**
 * Expand a word but suppress word-splitting and globbing — used when the
 * caller needs a single string (e.g. the target of `>`, the case subject,
 * heredoc body after expansion).
 */
export async function expandWordToString(word: Word, env: ShellEnv): Promise<string> {
  const pieces = await expandSegments({ segments: word.segments }, env);
  // Just concatenate all piece text, dropping quoting marks.
  return pieces.map((p) => p.text).join('');
}

/**
 * Expand a raw heredoc body (with or without variable expansion).
 */
export async function expandHeredoc(body: string, expand: boolean, env: ShellEnv): Promise<string> {
  if (!expand) return body;
  // Treat the body as a double-quoted string: $VAR, $(...), ${...} all expand
  // but literal text is preserved (no splitting, no globbing, no quote removal).
  const pseudo: Word = { segments: [{ type: 'double_quoted', segments: parseHeredocSegments(body) }] };
  return expandWordToString(pseudo, env);
}

// ---------------------------------------------------------------------
// Step 1: brace expansion — `a{b,c}d` → `abd`, `acd`
// ---------------------------------------------------------------------

/**
 * Apply brace expansion on the WORD level. Operates on the raw text
 * content of literal segments only (brace expansion is a tokenization
 * phase, pre-any-other-expansion).
 *
 * Returns a list of pseudo-Words. If a literal segment contains braces,
 * we split into multiple words with that segment's alternatives.
 */
function expandBraces(word: Word): Word[] {
  // Concatenate "brace-expandable text" per literal segment; non-literal
  // segments (quoted text, $, etc.) are untouched.
  // To keep things simple, we join all literals into a single string with
  // markers, brace-expand that string, then split back. This preserves
  // correct handling of adjacent quoted parts (which shouldn't participate
  // in brace expansion).
  //
  // In practice, brace expansion across quoted boundaries is rare; we
  // treat each literal segment independently.
  let variants: Word[] = [{ segments: [] }];
  for (const seg of word.segments) {
    if (seg.type === 'literal') {
      const alts = bashBraceExpand(seg.value);
      const next: Word[] = [];
      for (const existing of variants) {
        for (const alt of alts) {
          next.push({
            segments: [...existing.segments, { type: 'literal', value: alt }],
          });
        }
      }
      variants = next;
    } else {
      for (const v of variants) v.segments.push(seg);
    }
  }
  return variants;
}

/** Bash-style brace expansion of a single string. */
function bashBraceExpand(input: string): string[] {
  // Find the leftmost unescaped `{...}` with a comma at the top level,
  // or a numeric/alpha range `{a..b}`.
  const match = findOutermostBrace(input);
  if (!match) return [input];
  const { start, end, inner } = match;

  const prefix = input.slice(0, start);
  const suffix = input.slice(end + 1);
  const parts = splitOnTopLevelCommas(inner);
  if (parts.length < 2) {
    // `{a..b}` sequence?
    const seq = expandSequence(inner);
    if (seq) {
      return seq.flatMap((s) => bashBraceExpand(prefix + s + suffix));
    }
    // Not a real brace expansion — keep literal and continue.
    return [prefix + '{' + inner + '}' + suffix].flatMap((s) =>
      s === input ? [s] : bashBraceExpand(s),
    );
  }
  return parts.flatMap((p) => bashBraceExpand(prefix + p + suffix));
}

function findOutermostBrace(input: string): { start: number; end: number; inner: string } | null {
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue; }
    if (input[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < input.length && depth > 0) {
        if (input[j] === '\\') { j += 2; continue; }
        if (input[j] === '{') depth++;
        else if (input[j] === '}') {
          depth--;
          if (depth === 0) {
            return { start: i, end: j, inner: input.slice(i + 1, j) };
          }
        }
        j++;
      }
    }
  }
  return null;
}

function splitOnTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      current += c + s[i + 1];
      i++;
      continue;
    }
    if (c === '{') { depth++; current += c; continue; }
    if (c === '}') { depth--; current += c; continue; }
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

function expandSequence(inner: string): string[] | null {
  // {a..b} or {a..b..step} for integers or single letters.
  const parts = inner.split('..');
  if (parts.length < 2 || parts.length > 3) return null;
  const [a, b, stepStr] = parts;
  const step = stepStr ? parseInt(stepStr, 10) : 1;
  if (isNaN(step) || step === 0) return null;

  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
    const start = parseInt(a, 10);
    const end = parseInt(b, 10);
    const dir = start <= end ? 1 : -1;
    const real = Math.abs(step) * dir;
    const out: string[] = [];
    for (let i = start; dir > 0 ? i <= end : i >= end; i += real) {
      out.push(String(i));
    }
    return out;
  }
  if (a.length === 1 && b.length === 1 && /^[A-Za-z]$/.test(a) && /^[A-Za-z]$/.test(b)) {
    const start = a.charCodeAt(0);
    const end = b.charCodeAt(0);
    const dir = start <= end ? 1 : -1;
    const real = Math.abs(step) * dir;
    const out: string[] = [];
    for (let i = start; dir > 0 ? i <= end : i >= end; i += real) {
      out.push(String.fromCharCode(i));
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------
// Steps 2–5: segment expansion
// ---------------------------------------------------------------------

/** A piece of expanded text that remembers whether it came from quoted input. */
interface Piece {
  text: string;
  quoted: boolean;
}

async function expandSegments(word: Word, env: ShellEnv): Promise<Piece[]> {
  const out: Piece[] = [];
  for (let i = 0; i < word.segments.length; i++) {
    const seg = word.segments[i];
    const isFirstSegment = i === 0;
    const pieces = await expandSegment(seg, env, isFirstSegment);
    out.push(...pieces);
  }
  return out;
}

async function expandSegment(seg: WordSegment, env: ShellEnv, isFirst: boolean): Promise<Piece[]> {
  switch (seg.type) {
    case 'literal': {
      // Tilde expansion applies only at the start of an unquoted word.
      let text = seg.value;
      if (isFirst && text.startsWith('~') && (text.length === 1 || text[1] === '/')) {
        text = env.getHome() + text.slice(1);
      }
      return [{ text, quoted: false }];
    }
    case 'single_quoted':
      return [{ text: seg.value, quoted: true }];
    case 'double_quoted': {
      // Recurse into the inner segments, but treat everything as quoted.
      // Empty double-quoted strings still count as a present (empty) piece
      // so they produce an empty argument after splitting.
      const pieces: Piece[] = [];
      for (const inner of seg.segments) {
        const inside = await expandSegment(inner, env, false);
        for (const p of inside) pieces.push({ text: p.text, quoted: true });
      }
      if (pieces.length === 0) {
        pieces.push({ text: '', quoted: true });
      }
      return pieces;
    }
    case 'param': {
      const value = env.getVar(seg.name);
      return [{ text: value, quoted: false }];
    }
    case 'command_substitution': {
      const out = await env.runSubshell(seg.script);
      // Bash: strip trailing newlines from command substitution output.
      return [{ text: out.replace(/\n+$/, ''), quoted: false }];
    }
    case 'arithmetic': {
      const value = evalArithmetic(seg.expression, env);
      return [{ text: String(value), quoted: false }];
    }
  }
}

/**
 * Very small integer arithmetic evaluator: +, -, *, /, %, parentheses,
 * variable names (treated as their integer value or 0 if unset).
 * This is intentionally restricted; complex arithmetic is out of scope.
 */
function evalArithmetic(expr: string, env: ShellEnv): number {
  // Substitute bare identifiers with their variable values.
  const substituted = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
    const v = env.getVar(name);
    const n = parseInt(v, 10);
    return isNaN(n) ? '0' : String(n);
  });
  // Allow only integers, whitespace, operators, parens.
  if (!/^[\s\d+\-*/%()]+$/.test(substituted)) {
    return 0;
  }
  try {
    // Arithmetic context is strictly validated above; Function()
    // evaluates the cleaned integer expression.
    const result = new Function(`return (${substituted})`)();
    return Math.trunc(Number(result)) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------
// Step 6: word splitting on IFS whitespace
// ---------------------------------------------------------------------

/**
 * Split a piece sequence into fields. Unquoted whitespace inside a piece
 * is a field separator; quoted whitespace isn't.
 *
 * Returns an array of fields, each being a list of pieces (we keep the
 * quoting info for the subsequent glob step).
 */
function splitWords(pieces: Piece[]): Piece[][] {
  const ifs = ' \t\n'; // default IFS
  const fields: Piece[][] = [[]];
  for (const p of pieces) {
    if (p.quoted) {
      // Append whole piece to current field; no splitting.
      fields[fields.length - 1].push(p);
      continue;
    }
    // Walk characters; split on any IFS character.
    let buf = '';
    const flushBuf = () => {
      if (buf.length > 0) {
        fields[fields.length - 1].push({ text: buf, quoted: false });
        buf = '';
      }
    };
    let justSplit = false;
    for (const ch of p.text) {
      if (ifs.includes(ch)) {
        flushBuf();
        if (!justSplit && fields[fields.length - 1].length > 0) {
          fields.push([]);
          justSplit = true;
        }
      } else {
        buf += ch;
        justSplit = false;
      }
    }
    flushBuf();
  }
  // Drop trailing empty fields caused by trailing IFS whitespace.
  while (fields.length > 0 && fields[fields.length - 1].length === 0) {
    fields.pop();
  }
  // If the caller passed an empty quoted piece (e.g. `""`), preserve it
  // as a single empty field.
  if (fields.length === 0 && pieces.some((p) => p.quoted)) {
    return [[{ text: '', quoted: true }]];
  }
  return fields;
}

// ---------------------------------------------------------------------
// Step 7: glob expansion + quote removal
// ---------------------------------------------------------------------

async function maybeGlob(fields: Piece[], env: ShellEnv): Promise<string[]> {
  // If no unquoted glob metachars, just concat and return quote-removed.
  const joined = fields.map((p) => p.text).join('');
  const hasGlobChars = fields.some((p) => !p.quoted && /[*?[]/.test(p.text));
  if (!hasGlobChars) return [joined];

  // Build a pattern where quoted text is escaped (so `"*".txt` doesn't
  // glob the `*`). We track each character's quoted-ness.
  const chars: { ch: string; quoted: boolean }[] = [];
  for (const p of fields) {
    for (const ch of p.text) chars.push({ ch, quoted: p.quoted });
  }
  const matches = await globMatch(chars, env);
  if (matches.length > 0) {
    matches.sort();
    return matches;
  }
  // No match → pass literal through.
  return [joined];
}

async function globMatch(chars: { ch: string; quoted: boolean }[], env: ShellEnv): Promise<string[]> {
  // Split into path segments on unquoted '/'.
  const segments: { ch: string; quoted: boolean }[][] = [[]];
  let isAbsolute = false;
  for (let i = 0; i < chars.length; i++) {
    const { ch, quoted } = chars[i];
    if (ch === '/' && !quoted) {
      if (i === 0) isAbsolute = true;
      segments.push([]);
      continue;
    }
    segments[segments.length - 1].push(chars[i]);
  }

  let bases: string[] = [isAbsolute ? '/' : ''];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const isLast = si === segments.length - 1;
    if (seg.length === 0) continue; // leading slash
    const hasWild = seg.some((c) => !c.quoted && /[*?[]/.test(c.ch));
    const literal = seg.map((c) => c.ch).join('');

    if (!hasWild) {
      bases = bases.map((b) => joinPath(b, literal));
      continue;
    }

    const regex = globSegmentToRegex(seg);
    const next: string[] = [];
    for (const base of bases) {
      const dirPath = resolveForListing(base, env);
      let entries: string[];
      try {
        entries = await env.getFS().readdir(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.') && !literal.startsWith('.')) continue;
        if (!regex.test(entry)) continue;
        const combined = joinPath(base, entry);
        if (!isLast) {
          try {
            const stats = await env.getFS().stat(resolveForListing(combined, env));
            if (!stats.isDirectory()) continue;
          } catch { continue; }
        }
        next.push(combined);
      }
    }
    bases = next;
    if (bases.length === 0) break;
  }

  return bases;
}

function joinPath(base: string, segment: string): string {
  if (!base) return segment;
  if (base === '/') return '/' + segment;
  if (!segment) return base;
  return base + '/' + segment;
}

function resolveForListing(p: string, env: ShellEnv): string {
  if (!p) return env.getCwd();
  if (p.startsWith('/')) return p;
  return join(env.getCwd(), p);
}

function globSegmentToRegex(seg: { ch: string; quoted: boolean }[]): RegExp {
  let regex = '^';
  let i = 0;
  while (i < seg.length) {
    const { ch, quoted } = seg[i];
    if (quoted) {
      regex += escapeRegex(ch);
      i++;
      continue;
    }
    if (ch === '*') { regex += '[^/]*'; i++; continue; }
    if (ch === '?') { regex += '[^/]'; i++; continue; }
    if (ch === '[') {
      // Find matching ] (unquoted). Skip if not found.
      let close = -1;
      for (let j = i + 1; j < seg.length; j++) {
        if (!seg[j].quoted && seg[j].ch === ']') { close = j; break; }
      }
      if (close === -1) { regex += '\\['; i++; continue; }
      let cls = seg.slice(i + 1, close).map((c) => c.ch).join('');
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      regex += '[' + cls + ']';
      i = close + 1;
      continue;
    }
    regex += escapeRegex(ch);
    i++;
  }
  regex += '$';
  return new RegExp(regex);
}

function escapeRegex(ch: string): string {
  return '.+^$(){}|\\[]'.includes(ch) ? '\\' + ch : ch;
}

// ---------------------------------------------------------------------
// Heredoc helpers
// ---------------------------------------------------------------------

/**
 * Lightweight parser to split a heredoc body into segments similar to
 * the parser's double-quoted body splitter. Allows $VAR, ${...}, $(...)
 * and backticks; everything else is literal.
 */
function parseHeredocSegments(body: string): WordSegment[] {
  const out: WordSegment[] = [];
  let lit = '';
  const flush = () => { if (lit) { out.push({ type: 'literal', value: lit }); lit = ''; } };
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const n = body[i + 1];
      if (n === '$' || n === '`' || n === '\\') {
        lit += n;
        i += 2;
        continue;
      }
      lit += c;
      i++;
      continue;
    }
    if (c === '$') {
      const { expr, end } = readDollarCheap(body, i);
      flush();
      if (expr === '$') { lit += '$'; i = end; continue; }
      if (expr.startsWith('${') && expr.endsWith('}')) out.push({ type: 'param', name: expr.slice(2, -1) });
      else if (expr.startsWith('$((') && expr.endsWith('))')) out.push({ type: 'arithmetic', expression: expr.slice(3, -2) });
      else if (expr.startsWith('$(') && expr.endsWith(')')) out.push({ type: 'command_substitution', script: expr.slice(2, -1) });
      else out.push({ type: 'param', name: expr.slice(1) });
      i = end;
      continue;
    }
    if (c === '`') {
      const end = body.indexOf('`', i + 1);
      if (end === -1) { lit += c; i++; continue; }
      flush();
      out.push({ type: 'command_substitution', script: body.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  return out;
}

function readDollarCheap(s: string, i: number): { expr: string; end: number } {
  const start = i;
  i++;
  if (i >= s.length) return { expr: '$', end: i };
  const c = s[i];
  if (c === '{') {
    i++;
    let depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) break; }
      i++;
    }
    if (i < s.length) i++;
    return { expr: s.slice(start, i), end: i };
  }
  if (c === '(') {
    if (s[i + 1] === '(') {
      i += 2;
      let depth = 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') { depth--; if (depth === 0) { i++; if (s[i] === ')') i++; break; } }
        i++;
      }
      return { expr: s.slice(start, i), end: i };
    }
    i++;
    let depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0) break; }
      i++;
    }
    if (i < s.length) i++;
    return { expr: s.slice(start, i), end: i };
  }
  if (/[A-Za-z_]/.test(c)) {
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
    return { expr: s.slice(start, i), end: i };
  }
  if (c === '?' || c === '$' || c === '!' || c === '#' || c === '*' || c === '@' || c === '-' || /[0-9]/.test(c)) {
    i++;
    return { expr: s.slice(start, i), end: i };
  }
  return { expr: '$', end: i };
}
