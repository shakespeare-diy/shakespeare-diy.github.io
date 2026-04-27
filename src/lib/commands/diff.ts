import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'diff' command.
 *
 * Supported options:
 *   -u, --unified[=NUM]   Output NUM (default 3) lines of unified context
 *   -c                    Output default context format (3 lines) — alias -u
 *   -q, --brief           Report only whether files differ
 *   -s, --report-identical-files  Report when two files are the same
 *   -i, --ignore-case     Ignore case differences
 *   -w, --ignore-all-space
 *   -b, --ignore-space-change
 *   -B, --ignore-blank-lines
 *   -N, --new-file        Treat absent files as empty
 *   --                    End of options
 *
 * Diff output goes to stdout (POSIX). Exit codes:
 *   0 — files are identical
 *   1 — files differ
 *   2 — trouble (error)
 */
export class DiffCommand implements ShellCommand {
  name = 'diff';
  description = 'Compare files line by line';
  usage = 'diff [-uqsiwbBN] [--] file1 file2';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['u', 'c', 'q', 's', 'i', 'w', 'b', 'B', 'N'],
      booleanLong: [
        'unified', 'brief', 'report-identical-files', 'ignore-case',
        'ignore-all-space', 'ignore-space-change', 'ignore-blank-lines', 'new-file',
      ],
      longToShort: {
        unified: 'u',
        brief: 'q',
        'report-identical-files': 's',
        'ignore-case': 'i',
        'ignore-all-space': 'w',
        'ignore-space-change': 'b',
        'ignore-blank-lines': 'B',
        'new-file': 'N',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`, 2);
    }

    const opts = {
      unified: parsed.flags.has('u') || parsed.flags.has('c'),
      brief: parsed.flags.has('q'),
      reportIdentical: parsed.flags.has('s'),
      ignoreCase: parsed.flags.has('i'),
      ignoreAllSpace: parsed.flags.has('w'),
      ignoreSpaceChange: parsed.flags.has('b'),
      ignoreBlankLines: parsed.flags.has('B'),
      treatMissingAsEmpty: parsed.flags.has('N'),
    };

    if (parsed.operands.length !== 2) {
      return createErrorResult(`${this.name}: missing operand (need exactly 2 files)`, 2);
    }
    const [file1, file2] = parsed.operands;

    const loadFile = async (path: string): Promise<string | undefined> => {
      try {
        const abs = resolvePath(path, cwd);
        const stats = await this.fs.stat(abs);
        if (stats.isDirectory()) throw new Error(`${path}: Is a directory`);
        return await this.fs.readFile(abs, 'utf8');
      } catch (error) {
        const { kind, message } = classifyFsError(error);
        if (kind === 'ENOENT' && opts.treatMissingAsEmpty) return '';
        if (kind === 'ENOENT') {
          throw new Error(`${this.name}: ${path}: No such file or directory`);
        }
        if (/Is a directory/.test(message)) {
          throw new Error(`${this.name}: ${path}: Is a directory`);
        }
        throw new Error(`${this.name}: ${path}: ${message}`);
      }
    };

    let content1: string;
    let content2: string;
    try {
      content1 = (await loadFile(file1))!;
      content2 = (await loadFile(file2))!;
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : 'Unknown error', 2);
    }

    const normalize = (s: string): string => {
      if (opts.ignoreCase) s = s.toLowerCase();
      if (opts.ignoreAllSpace) s = s.replace(/\s+/g, '');
      else if (opts.ignoreSpaceChange) s = s.replace(/\s+/g, ' ').trim();
      return s;
    };

    const splitLines = (s: string): string[] => {
      if (s === '') return [];
      const lines = s.split('\n');
      if (lines[lines.length - 1] === '' && s.endsWith('\n')) lines.pop();
      return lines;
    };

    let lines1 = splitLines(content1);
    let lines2 = splitLines(content2);

    if (opts.ignoreBlankLines) {
      lines1 = lines1.filter((l) => l.trim() !== '');
      lines2 = lines2.filter((l) => l.trim() !== '');
    }

    const eq = (a: string, b: string) => normalize(a) === normalize(b);

    // Fast path: identical.
    if (lines1.length === lines2.length && lines1.every((l, i) => eq(l, lines2[i]))) {
      if (opts.reportIdentical) {
        return createSuccessResult(`Files ${file1} and ${file2} are identical\n`);
      }
      return createSuccessResult('');
    }

    if (opts.brief) {
      return {
        exitCode: 1,
        stdout: `Files ${file1} and ${file2} differ\n`,
        stderr: '',
      };
    }

    const ops = computeDiff(lines1, lines2, eq);
    const output = opts.unified
      ? formatUnified(ops, lines1, lines2, file1, file2, 3)
      : formatNormal(ops, lines1, lines2);

    return {
      exitCode: 1,
      stdout: output,
      stderr: '',
    };
  }
}

// ---------------------------------------------------------------------------
// Diff algorithm (Myers' classic LCS via dynamic programming).
// Sufficient for typical file sizes.
// ---------------------------------------------------------------------------

type Op =
  | { kind: 'equal'; aIdx: number; bIdx: number }
  | { kind: 'del'; aIdx: number }
  | { kind: 'add'; bIdx: number };

function computeDiff(a: string[], b: string[], eq: (x: string, y: string) => boolean): Op[] {
  const m = a.length;
  const n = b.length;
  // LCS table.
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (eq(a[i], b[j])) lcs[i][j] = lcs[i + 1][j + 1] + 1;
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (eq(a[i], b[j])) {
      ops.push({ kind: 'equal', aIdx: i, bIdx: j });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'del', aIdx: i });
      i++;
    } else {
      ops.push({ kind: 'add', bIdx: j });
      j++;
    }
  }
  while (i < m) { ops.push({ kind: 'del', aIdx: i++ }); }
  while (j < n) { ops.push({ kind: 'add', bIdx: j++ }); }
  return ops;
}

function formatNormal(ops: Op[], a: string[], b: string[]): string {
  // Group consecutive del/add/equal runs.
  const out: string[] = [];
  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx];
    if (op.kind === 'equal') { idx++; continue; }

    const dels: number[] = [];
    const adds: number[] = [];
    while (idx < ops.length && ops[idx].kind !== 'equal') {
      const o = ops[idx];
      if (o.kind === 'del') dels.push(o.aIdx);
      if (o.kind === 'add') adds.push(o.bIdx);
      idx++;
    }

    // Determine ranges and command character.
    const aStart = dels.length > 0 ? dels[0] + 1 : (idx < ops.length ? (ops[idx] as Extract<Op, { kind: 'equal' }>).aIdx : a.length) ;
    const aEnd = dels.length > 0 ? dels[dels.length - 1] + 1 : aStart - 1;
    const bStart = adds.length > 0 ? adds[0] + 1 : (idx < ops.length ? (ops[idx] as Extract<Op, { kind: 'equal' }>).bIdx : b.length);
    const bEnd = adds.length > 0 ? adds[adds.length - 1] + 1 : bStart - 1;

    const aSpec = aStart === aEnd ? `${aStart}` : `${aStart},${aEnd}`;
    const bSpec = bStart === bEnd ? `${bStart}` : `${bStart},${bEnd}`;

    if (dels.length > 0 && adds.length > 0) {
      out.push(`${aSpec}c${bSpec}`);
      for (const di of dels) out.push(`< ${a[di]}`);
      out.push('---');
      for (const ai of adds) out.push(`> ${b[ai]}`);
    } else if (dels.length > 0) {
      // Deletion: reference line in b is the one right before where deletions are.
      const bRef = idx > 0 && ops[idx - dels.length - 1] && ops[idx - dels.length - 1].kind === 'equal'
        ? (ops[idx - dels.length - 1] as Extract<Op, { kind: 'equal' }>).bIdx + 1
        : 0;
      out.push(`${aSpec}d${bRef}`);
      for (const di of dels) out.push(`< ${a[di]}`);
    } else if (adds.length > 0) {
      // Addition: reference line in a is the one right before.
      const aRef = idx > 0 && ops[idx - adds.length - 1] && ops[idx - adds.length - 1].kind === 'equal'
        ? (ops[idx - adds.length - 1] as Extract<Op, { kind: 'equal' }>).aIdx + 1
        : 0;
      out.push(`${aRef}a${bSpec}`);
      for (const ai of adds) out.push(`> ${b[ai]}`);
    }
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
}

function formatUnified(
  ops: Op[],
  a: string[],
  b: string[],
  file1: string,
  file2: string,
  context: number,
): string {
  const out: string[] = [];
  out.push(`--- ${file1}`);
  out.push(`+++ ${file2}`);

  // Build hunks.
  const hunks: Array<{ aStart: number; aCount: number; bStart: number; bCount: number; lines: string[] }> = [];
  let i = 0;
  while (i < ops.length) {
    // Skip equal runs until next change.
    if (ops[i].kind === 'equal') { i++; continue; }

    // Start a hunk. Backtrack for leading context.
    let hunkStart = i;
    let contextBefore = 0;
    while (hunkStart > 0 && ops[hunkStart - 1].kind === 'equal' && contextBefore < context) {
      hunkStart--;
      contextBefore++;
    }

    let j = i;
    while (j < ops.length) {
      if (ops[j].kind !== 'equal') {
        j++;
        continue;
      }
      // Lookahead: if the next `context*2` are all equal and then end-of-diff
      // or another change too far, close the hunk.
      let equalRun = 0;
      let k = j;
      while (k < ops.length && ops[k].kind === 'equal') {
        equalRun++;
        k++;
      }
      if (k >= ops.length || equalRun > context * 2) {
        // Include up to `context` trailing equals.
        j = Math.min(j + context, ops.length);
        break;
      }
      j = k;
    }

    // Build hunk details.
    const hunkOps = ops.slice(hunkStart, j);
    const firstA = hunkOps.find((o) => o.kind !== 'add');
    const firstB = hunkOps.find((o) => o.kind !== 'del');
    const aStart = firstA
      ? (firstA.kind === 'equal' ? firstA.aIdx : firstA.aIdx) + 1
      : 1;
    const bStart = firstB
      ? (firstB.kind === 'equal' ? firstB.bIdx : firstB.bIdx) + 1
      : 1;

    let aCount = 0;
    let bCount = 0;
    const lines: string[] = [];
    for (const o of hunkOps) {
      if (o.kind === 'equal') {
        lines.push(' ' + a[o.aIdx]);
        aCount++;
        bCount++;
      } else if (o.kind === 'del') {
        lines.push('-' + a[o.aIdx]);
        aCount++;
      } else {
        lines.push('+' + b[o.bIdx]);
        bCount++;
      }
    }

    hunks.push({ aStart, aCount, bStart, bCount, lines });
    i = j;
  }

  for (const h of hunks) {
    const aSpec = h.aCount === 1 ? String(h.aStart) : `${h.aStart},${h.aCount}`;
    const bSpec = h.bCount === 1 ? String(h.bStart) : `${h.bStart},${h.bCount}`;
    out.push(`@@ -${aSpec} +${bSpec} @@`);
    out.push(...h.lines);
  }

  return out.join('\n') + (out.length > 0 ? '\n' : '');
}
