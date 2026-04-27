import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitLsFilesCommand } from './ls-files';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const mockFS = {
  stat: async (path: string) => {
    if (path.endsWith('/.git')) {
      return { isDirectory: () => true };
    }
    throw new Error('File not found');
  },
} as unknown as JSRuntimeFS;

describe('GitLsFilesCommand', () => {
  let lsFilesCommand: GitLsFilesCommand;
  let mockGit: Git;

  beforeEach(() => {
    mockGit = {
      statusMatrix: vi.fn().mockResolvedValue([
        // [filepath, headStatus, workdirStatus, stageStatus]
        ['file1.txt', 1, 1, 1], // Tracked, unchanged
        ['file2.txt', 1, 1, 1], // Tracked, unchanged
      ]),
      resolveRef: vi.fn().mockResolvedValue('abc123'),
      readBlob: vi.fn().mockResolvedValue({ oid: 'blob1', blob: new Uint8Array() }),
    } as unknown as Git;

    lsFilesCommand = new GitLsFilesCommand({ git: mockGit, fs: mockFS });
  });

  it('should list tracked files', async () => {
    const result = await lsFilesCommand.execute([], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('file1.txt');
    expect(result.stdout).toContain('file2.txt');
  });

  it('should list modified files with -m', async () => {
    mockGit.statusMatrix = vi.fn().mockResolvedValue([
      ['file1.txt', 1, 2, 1], // Modified
      ['file2.txt', 1, 1, 1], // Unchanged
    ]);
    const result = await lsFilesCommand.execute(['-m'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('file1.txt');
    expect(result.stdout).not.toContain('file2.txt');
  });

  it('should list untracked files with -o', async () => {
    mockGit.statusMatrix = vi.fn().mockResolvedValue([
      ['file1.txt', 1, 1, 1], // Tracked
      ['untracked.txt', 0, 2, 0], // Untracked
    ]);
    const result = await lsFilesCommand.execute(['-o'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('untracked.txt');
    expect(result.stdout).not.toContain('file1.txt');
  });

  it('should list deleted files with -d', async () => {
    mockGit.statusMatrix = vi.fn().mockResolvedValue([
      ['deleted.txt', 1, 0, 1], // Deleted
      ['file.txt', 1, 1, 1], // Unchanged
    ]);
    const result = await lsFilesCommand.execute(['-d'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('deleted.txt');
    expect(result.stdout).not.toContain('file.txt');
  });

  it('should fail when not in a git repo', async () => {
    const mockFSNoGit = {
      stat: async () => { throw new Error('ENOENT'); },
    } as unknown as JSRuntimeFS;
    const cmd = new GitLsFilesCommand({ git: mockGit, fs: mockFSNoGit });
    const result = await cmd.execute([], '/not-a-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });
});
