
import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

interface DiffOptions {
  cached: boolean;
  nameOnly: boolean;
  nameStatus: boolean;
  stat: boolean;
}

interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type?: string;
}

type ChangeType = 'add' | 'modify' | 'delete';

export class GitDiffCommand implements GitSubcommand {
  name = 'diff';
  description = 'Show changes between commits, commit and working tree, etc';
  usage = 'git diff [--cached | --staged] [--stat] [--name-only] [--name-status] [<commit>] [<commit>] [-- <path>...]';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      // Check if we're in a git repository
      try {
        await this.fs.stat(`${cwd}/.git`);
      } catch {
        return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
      }

      const { commits, paths, options } = this.parseArgs(args);

      if (options.cached) {
        // Show staged changes (index vs HEAD) or (commit vs index)
        return await this.showStagedDiff(paths, options, cwd, commits[0]);
      } else if (commits.length === 0) {
        // Show working directory changes vs index
        return await this.showWorkingDirectoryDiff(paths, options, cwd);
      } else if (commits.length === 1) {
        // Show changes between commit and working directory
        return await this.showCommitVsWorkdir(commits[0], paths, options, cwd);
      } else if (commits.length === 2) {
        // Show changes between two commits
        return await this.showCommitRangeDiff(commits[0], commits[1], paths, options, cwd);
      } else {
        return createErrorResult('usage: git diff [<commit>] [<commit>] [-- <path>...]');
      }

    } catch (error) {
      return createErrorResult(`git diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    commits: string[];
    paths: string[];
    options: DiffOptions;
  } {
    const options: DiffOptions = {
      cached: false,
      nameOnly: false,
      nameStatus: false,
      stat: false,
    };
    const commits: string[] = [];
    const paths: string[] = [];
    let foundDoubleDash = false;

    for (const arg of args) {
      if (arg === '--') {
        foundDoubleDash = true;
        continue;
      }

      if (foundDoubleDash) {
        paths.push(arg);
      } else if (arg === '--cached' || arg === '--staged') {
        options.cached = true;
      } else if (arg === '--name-only') {
        options.nameOnly = true;
      } else if (arg === '--name-status') {
        options.nameStatus = true;
      } else if (arg === '--stat') {
        options.stat = true;
      } else if (arg.startsWith('-')) {
        // Unknown option, ignore for now
        continue;
      } else if (arg.includes('..')) {
        // Range syntax: commit1..commit2
        const [c1, c2] = arg.split('..');
        if (c1) commits.push(c1);
        if (c2) commits.push(c2);
      } else {
        commits.push(arg);
      }
    }

    return { commits, paths, options };
  }

  /**
   * Match a file path against optional pathspec filters using prefix matching.
   */
  private matchesPaths(filepath: string, paths: string[]): boolean {
    if (paths.length === 0) return true;
    return paths.some(p => {
      if (p === '.') return true;
      return filepath === p || filepath.startsWith(p.endsWith('/') ? p : p + '/');
    });
  }

  /**
   * Read a file's content from the working directory
   */
  private async readWorkdirFile(cwd: string, filepath: string): Promise<string> {
    try {
      return await this.fs.readFile(`${cwd}/${filepath}`, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Read a file's content from a tree (commit)
   */
  private async readBlobFromRef(cwd: string, ref: string, filepath: string): Promise<string> {
    try {
      const blob = await this.git.readBlob({
        dir: cwd,
        oid: ref,
        filepath,
      });
      return new TextDecoder().decode(blob.blob);
    } catch {
      return '';
    }
  }

  /**
   * Read a file's content from the index (stage) via updateIndex/readBlob hack.
   * Since isomorphic-git doesn't directly expose reading from the index,
   * fall back to reading from HEAD when possible, or from working directory.
   */
  private async readIndexContent(
    cwd: string,
    filepath: string,
    stageStatus: number,
    headStatus: number
  ): Promise<string> {
    // If the stage matches HEAD, read from HEAD
    if (stageStatus === 1 && headStatus === 1) {
      return this.readBlobFromRef(cwd, 'HEAD', filepath);
    }
    // If file is in stage (either new or modified), we approximate by reading
    // working directory. This is imperfect but the best we can do without
    // direct index reading in isomorphic-git.
    if (stageStatus === 2) {
      return this.readWorkdirFile(cwd, filepath);
    }
    return '';
  }

  /**
   * Generate a unified diff between two strings with proper context lines.
   */
  private generateUnifiedDiff(
    oldContent: string,
    newContent: string,
    oldPath: string,
    newPath: string
  ): string[] {
    const lines: string[] = [];
    const oldLines = oldContent === '' ? [] : oldContent.split('\n');
    const newLines = newContent === '' ? [] : newContent.split('\n');

    // Use LCS-based diff
    const hunks = this.computeHunks(oldLines, newLines, 3);

    for (const hunk of hunks) {
      const oldSize = hunk.oldEnd - hunk.oldStart;
      const newSize = hunk.newEnd - hunk.newStart;
      lines.push(`@@ -${hunk.oldStart + 1},${oldSize} +${hunk.newStart + 1},${newSize} @@`);
      for (const line of hunk.lines) {
        lines.push(line);
      }
    }

    if (lines.length === 0 && oldPath !== newPath) {
      lines.push('(No textual differences)');
    }
    return lines;
  }

  /**
   * Compute hunks using a simple Myers-like diff algorithm.
   */
  private computeHunks(oldLines: string[], newLines: string[], context: number): Array<{
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    lines: string[];
  }> {
    // Compute LCS table (for small files - could be inefficient for huge files)
    const m = oldLines.length;
    const n = newLines.length;

    // For performance, cap LCS to reasonable sizes
    if (m > 5000 || n > 5000) {
      // Fall back to naive line-by-line diff for huge files
      return this.naiveDiffHunks(oldLines, newLines, context);
    }

    const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldLines[i] === newLines[j]) {
          lcs[i][j] = lcs[i + 1][j + 1] + 1;
        } else {
          lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
      }
    }

    // Generate the edit script
    type Op = { op: ' ' | '-' | '+'; oldIdx: number; newIdx: number; line: string };
    const ops: Op[] = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        ops.push({ op: ' ', oldIdx: i, newIdx: j, line: oldLines[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        ops.push({ op: '-', oldIdx: i, newIdx: j, line: oldLines[i] });
        i++;
      } else {
        ops.push({ op: '+', oldIdx: i, newIdx: j, line: newLines[j] });
        j++;
      }
    }
    while (i < m) {
      ops.push({ op: '-', oldIdx: i, newIdx: j, line: oldLines[i] });
      i++;
    }
    while (j < n) {
      ops.push({ op: '+', oldIdx: i, newIdx: j, line: newLines[j] });
      j++;
    }

    // Group into hunks using context
    const hunks: Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number; lines: string[] }> = [];
    let hunkStart = -1;

    for (let k = 0; k < ops.length; k++) {
      if (ops[k].op !== ' ') {
        if (hunkStart < 0) {
          hunkStart = Math.max(0, k - context);
        }
      } else if (hunkStart >= 0) {
        // Check if next non-context op is within 2*context
        let nextChange = -1;
        for (let l = k + 1; l < ops.length && l < k + 2 * context + 1; l++) {
          if (ops[l].op !== ' ') {
            nextChange = l;
            break;
          }
        }
        if (nextChange < 0) {
          // Close the hunk
          const hunkEnd = Math.min(ops.length, k + context);
          hunks.push(this.buildHunk(ops, hunkStart, hunkEnd));
          hunkStart = -1;
        }
      }
    }
    if (hunkStart >= 0) {
      hunks.push(this.buildHunk(ops, hunkStart, ops.length));
    }

    return hunks;
  }

  private buildHunk(
    ops: Array<{ op: ' ' | '-' | '+'; oldIdx: number; newIdx: number; line: string }>,
    start: number,
    end: number
  ): { oldStart: number; oldEnd: number; newStart: number; newEnd: number; lines: string[] } {
    // Count how many old-side and new-side lines appear in this hunk
    let oldCount = 0;
    let newCount = 0;
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const o = ops[i];
      if (o.op === ' ') {
        lines.push(` ${o.line}`);
        oldCount++;
        newCount++;
      } else if (o.op === '-') {
        lines.push(`-${o.line}`);
        oldCount++;
      } else {
        lines.push(`+${o.line}`);
        newCount++;
      }
    }

    // Find the old/new starting line numbers by scanning from beginning
    let oldPos = 0, newPos = 0;
    for (let i = 0; i < start; i++) {
      if (ops[i].op !== '+') oldPos++;
      if (ops[i].op !== '-') newPos++;
    }

    return {
      oldStart: oldPos,
      oldEnd: oldPos + oldCount,
      newStart: newPos,
      newEnd: newPos + newCount,
      lines,
    };
  }

  /**
   * Naive line-by-line diff for large files.
   */
  private naiveDiffHunks(oldLines: string[], newLines: string[], _context: number): Array<{
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
    lines: string[];
  }> {
    const lines: string[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];
      if (oldLine !== undefined && newLine !== undefined) {
        if (oldLine === newLine) {
          lines.push(` ${oldLine}`);
        } else {
          lines.push(`-${oldLine}`);
          lines.push(`+${newLine}`);
        }
      } else if (oldLine !== undefined) {
        lines.push(`-${oldLine}`);
      } else if (newLine !== undefined) {
        lines.push(`+${newLine}`);
      }
    }
    return [{
      oldStart: 0,
      oldEnd: oldLines.length,
      newStart: 0,
      newEnd: newLines.length,
      lines,
    }];
  }

  /**
   * Get the git-style short hash for a file's contents (using hashBlob).
   */
  private async getGitShortHash(content: string): Promise<string> {
    try {
      const encoder = new TextEncoder();
      const buf = encoder.encode(content);
      const result = await this.git.hashBlob({ object: buf });
      return result.oid.substring(0, 7);
    } catch {
      // Fallback to a placeholder
      return '0000000';
    }
  }

  /**
   * Emit diff output (unified, stat, or name-only) for a set of changes.
   */
  private async emitDiff(
    changes: Array<{
      filepath: string;
      oldContent: string;
      newContent: string;
      oldMode?: string;
      newMode?: string;
      changeType: ChangeType;
    }>,
    options: DiffOptions
  ): Promise<string> {
    if (options.nameOnly) {
      return changes.map(c => c.filepath).join('\n') + (changes.length > 0 ? '\n' : '');
    }

    if (options.nameStatus) {
      return changes.map(c => {
        const status = c.changeType === 'add' ? 'A' : c.changeType === 'delete' ? 'D' : 'M';
        return `${status}\t${c.filepath}`;
      }).join('\n') + (changes.length > 0 ? '\n' : '');
    }

    if (options.stat) {
      const lines: string[] = [];
      let totalAdd = 0, totalDel = 0;
      const maxPathLen = Math.max(10, ...changes.map(c => c.filepath.length));
      for (const change of changes) {
        const oldLines = change.oldContent === '' ? 0 : change.oldContent.split('\n').length;
        const newLines = change.newContent === '' ? 0 : change.newContent.split('\n').length;
        const adds = Math.max(0, newLines - (change.changeType === 'delete' ? newLines : oldLines));
        const dels = Math.max(0, oldLines - (change.changeType === 'add' ? oldLines : newLines));
        // For modifications, try to compute actual changes
        let actualAdds = 0, actualDels = 0;
        if (change.changeType === 'modify') {
          const hunks = this.computeHunks(
            change.oldContent.split('\n'),
            change.newContent.split('\n'),
            0
          );
          for (const hunk of hunks) {
            for (const l of hunk.lines) {
              if (l.startsWith('+')) actualAdds++;
              else if (l.startsWith('-')) actualDels++;
            }
          }
        } else if (change.changeType === 'add') {
          actualAdds = newLines;
        } else {
          actualDels = oldLines;
        }
        totalAdd += actualAdds;
        totalDel += actualDels;
        const bar = '+'.repeat(Math.min(actualAdds, 40)) + '-'.repeat(Math.min(actualDels, 40));
        lines.push(` ${change.filepath.padEnd(maxPathLen)} | ${actualAdds + actualDels} ${bar}`);
        // suppress unused-variable warnings
        void adds; void dels;
      }
      lines.push(` ${changes.length} file${changes.length !== 1 ? 's' : ''} changed, ${totalAdd} insertion${totalAdd !== 1 ? 's' : ''}(+), ${totalDel} deletion${totalDel !== 1 ? 's' : ''}(-)`);
      return lines.join('\n') + '\n';
    }

    // Full unified diff
    const diffLines: string[] = [];
    for (const change of changes) {
      const oldHash = await this.getGitShortHash(change.oldContent);
      const newHash = await this.getGitShortHash(change.newContent);

      diffLines.push(`diff --git a/${change.filepath} b/${change.filepath}`);

      if (change.changeType === 'add') {
        diffLines.push(`new file mode ${change.newMode || '100644'}`);
        diffLines.push(`index 0000000..${newHash}`);
        diffLines.push('--- /dev/null');
        diffLines.push(`+++ b/${change.filepath}`);
      } else if (change.changeType === 'delete') {
        diffLines.push(`deleted file mode ${change.oldMode || '100644'}`);
        diffLines.push(`index ${oldHash}..0000000`);
        diffLines.push(`--- a/${change.filepath}`);
        diffLines.push('+++ /dev/null');
      } else {
        diffLines.push(`index ${oldHash}..${newHash} ${change.newMode || '100644'}`);
        diffLines.push(`--- a/${change.filepath}`);
        diffLines.push(`+++ b/${change.filepath}`);
      }

      const hunks = this.generateUnifiedDiff(
        change.oldContent,
        change.newContent,
        change.filepath,
        change.filepath
      );
      diffLines.push(...hunks);
    }

    return diffLines.join('\n') + (diffLines.length > 0 ? '\n' : '');
  }

  private async showWorkingDirectoryDiff(
    paths: string[],
    options: DiffOptions,
    cwd: string
  ): Promise<ShellCommandResult> {
    try {
      const statusMatrix = await this.git.statusMatrix({ dir: cwd });

      const changedFiles = statusMatrix.filter(([filepath, _headStatus, workdirStatus, stageStatus]) => {
        // Working dir differs from stage, but exclude purely untracked files
        const hasChanges = (stageStatus !== workdirStatus && workdirStatus === 2 && stageStatus !== 0) ||
                          (stageStatus === 2 && workdirStatus === 0) ||
                          (stageStatus === 1 && workdirStatus === 0);
        return hasChanges && this.matchesPaths(filepath, paths);
      });

      if (changedFiles.length === 0) {
        return createSuccessResult('');
      }

      const changes: Parameters<typeof this.emitDiff>[0] = [];
      for (const [filepath, headStatus, workdirStatus, stageStatus] of changedFiles) {
        const oldContent = await this.readIndexContent(cwd, filepath, stageStatus, headStatus);
        const newContent = workdirStatus === 0 ? '' : await this.readWorkdirFile(cwd, filepath);

        if (oldContent === newContent) continue;

        const changeType: ChangeType = workdirStatus === 0 ? 'delete' : 'modify';
        changes.push({ filepath, oldContent, newContent, changeType });
      }

      return createSuccessResult(await this.emitDiff(changes, options));
    } catch (error) {
      return createErrorResult(`Failed to show diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async showStagedDiff(
    paths: string[],
    options: DiffOptions,
    cwd: string,
    baseCommit?: string
  ): Promise<ShellCommandResult> {
    try {
      const statusMatrix = await this.git.statusMatrix({ dir: cwd });
      const base = baseCommit || 'HEAD';

      const stagedFiles = statusMatrix.filter(([filepath, headStatus, _workdirStatus, stageStatus]) => {
        const hasStagedChanges = (headStatus === 0 && stageStatus === 2) ||
                                (headStatus === 1 && stageStatus === 0) ||
                                (headStatus === 1 && stageStatus === 2);
        return hasStagedChanges && this.matchesPaths(filepath, paths);
      });

      if (stagedFiles.length === 0) {
        return createSuccessResult('');
      }

      const changes: Parameters<typeof this.emitDiff>[0] = [];
      for (const [filepath, headStatus, _workdirStatus, stageStatus] of stagedFiles) {
        const oldContent = headStatus === 1 ? await this.readBlobFromRef(cwd, base, filepath) : '';
        // For staged, approximate with working dir (see readIndexContent for details)
        const newContent = stageStatus === 0 ? '' : await this.readWorkdirFile(cwd, filepath);

        let changeType: ChangeType = 'modify';
        if (headStatus === 0 && stageStatus === 2) changeType = 'add';
        else if (headStatus === 1 && stageStatus === 0) changeType = 'delete';

        changes.push({ filepath, oldContent, newContent, changeType });
      }

      return createSuccessResult(await this.emitDiff(changes, options));
    } catch (error) {
      return createErrorResult(`Failed to show staged diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Show diff between a commit and the working directory.
   */
  private async showCommitVsWorkdir(
    commit: string,
    paths: string[],
    options: DiffOptions,
    cwd: string
  ): Promise<ShellCommandResult> {
    try {
      // Resolve the commit
      let commitOid: string;
      try {
        commitOid = await this.git.resolveRef({ dir: cwd, ref: commit });
      } catch {
        return createErrorResult(`fatal: bad revision '${commit}'`);
      }

      // List all files in the commit tree
      const commitFiles = await this.listFilesInCommit(cwd, commitOid);

      // List all files in the working directory (via statusMatrix)
      const statusMatrix = await this.git.statusMatrix({ dir: cwd });

      const changes: Parameters<typeof this.emitDiff>[0] = [];
      const seen = new Set<string>();

      // Files present in working dir
      for (const [filepath, _h, workdirStatus, _s] of statusMatrix) {
        if (!this.matchesPaths(filepath, paths)) continue;
        seen.add(filepath);

        const oldContent = commitFiles.has(filepath)
          ? await this.readBlobFromRef(cwd, commitOid, filepath)
          : '';
        const newContent = workdirStatus === 0 ? '' : await this.readWorkdirFile(cwd, filepath);

        if (oldContent === newContent) continue;

        let changeType: ChangeType = 'modify';
        if (!commitFiles.has(filepath)) changeType = 'add';
        else if (workdirStatus === 0) changeType = 'delete';

        changes.push({ filepath, oldContent, newContent, changeType });
      }

      // Files only in the commit tree (deleted)
      for (const filepath of commitFiles) {
        if (seen.has(filepath)) continue;
        if (!this.matchesPaths(filepath, paths)) continue;

        const oldContent = await this.readBlobFromRef(cwd, commitOid, filepath);
        const newContent = await this.readWorkdirFile(cwd, filepath);
        if (oldContent === newContent) continue;

        changes.push({ filepath, oldContent, newContent, changeType: 'delete' });
      }

      return createSuccessResult(await this.emitDiff(changes, options));
    } catch (error) {
      return createErrorResult(`Failed to show commit diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Show diff between two commits.
   */
  private async showCommitRangeDiff(
    commit1: string,
    commit2: string,
    paths: string[],
    options: DiffOptions,
    cwd: string
  ): Promise<ShellCommandResult> {
    try {
      let oid1: string;
      let oid2: string;
      try {
        oid1 = await this.git.resolveRef({ dir: cwd, ref: commit1 });
      } catch {
        return createErrorResult(`fatal: bad revision '${commit1}'`);
      }
      try {
        oid2 = await this.git.resolveRef({ dir: cwd, ref: commit2 });
      } catch {
        return createErrorResult(`fatal: bad revision '${commit2}'`);
      }

      const files1 = await this.listFilesInCommit(cwd, oid1);
      const files2 = await this.listFilesInCommit(cwd, oid2);

      const changes: Parameters<typeof this.emitDiff>[0] = [];
      const allFiles = new Set([...files1, ...files2]);

      for (const filepath of allFiles) {
        if (!this.matchesPaths(filepath, paths)) continue;

        const in1 = files1.has(filepath);
        const in2 = files2.has(filepath);

        const oldContent = in1 ? await this.readBlobFromRef(cwd, oid1, filepath) : '';
        const newContent = in2 ? await this.readBlobFromRef(cwd, oid2, filepath) : '';

        if (oldContent === newContent) continue;

        let changeType: ChangeType = 'modify';
        if (!in1) changeType = 'add';
        else if (!in2) changeType = 'delete';

        changes.push({ filepath, oldContent, newContent, changeType });
      }

      return createSuccessResult(await this.emitDiff(changes, options));
    } catch (error) {
      return createErrorResult(`Failed to show commit range diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Recursively list all files in a commit's tree.
   */
  private async listFilesInCommit(cwd: string, commitOid: string): Promise<Set<string>> {
    const files = new Set<string>();

    const walkTree = async (oid: string, prefix: string): Promise<void> => {
      try {
        const tree = await this.git.readTree({ dir: cwd, oid });
        for (const entry of tree.tree as TreeEntry[]) {
          const path = prefix ? `${prefix}/${entry.path}` : entry.path;
          if (entry.mode === '040000' || entry.type === 'tree') {
            await walkTree(entry.oid, path);
          } else {
            files.add(path);
          }
        }
      } catch {
        // Ignore tree read errors
      }
    };

    try {
      // readTree with a commit oid resolves to the commit's tree
      await walkTree(commitOid, '');
    } catch {
      // Ignore
    }

    return files;
  }
}
