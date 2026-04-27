import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitRestoreCommand } from './restore';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const mockFS = {
  stat: async (path: string) => {
    if (path.endsWith('/.git')) return { isDirectory: () => true };
    throw new Error('ENOENT');
  },
} as unknown as JSRuntimeFS;

describe('GitRestoreCommand', () => {
  let restoreCommand: GitRestoreCommand;
  let mockGit: Git;

  beforeEach(() => {
    mockGit = {
      checkout: vi.fn(async () => {}),
      resetIndex: vi.fn(async () => {}),
    } as unknown as Git;
    restoreCommand = new GitRestoreCommand({ git: mockGit, fs: mockFS });
  });

  it('should fail without path arguments', async () => {
    const result = await restoreCommand.execute([], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('specify path');
  });

  it('should fail when not in a git repo', async () => {
    const mockFSNoGit = {
      stat: async () => { throw new Error('ENOENT'); },
    } as unknown as JSRuntimeFS;
    const cmd = new GitRestoreCommand({ git: mockGit, fs: mockFSNoGit });
    const result = await cmd.execute(['foo.txt'], '/not-a-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  it('should restore a file from HEAD by default', async () => {
    const result = await restoreCommand.execute(['file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockGit.checkout).toHaveBeenCalledWith(expect.objectContaining({
      dir: '/test-repo',
      ref: 'HEAD',
      filepaths: ['file1.txt'],
      force: true,
    }));
  });

  it('should unstage with --staged', async () => {
    const result = await restoreCommand.execute(['--staged', 'file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockGit.resetIndex).toHaveBeenCalledWith({ dir: '/test-repo', filepath: 'file1.txt' });
    expect(mockGit.checkout).not.toHaveBeenCalled();
  });

  it('should restore both index and worktree with --staged --worktree', async () => {
    const result = await restoreCommand.execute(['--staged', '--worktree', 'file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockGit.resetIndex).toHaveBeenCalled();
    expect(mockGit.checkout).toHaveBeenCalled();
  });

  it('should accept --source', async () => {
    const result = await restoreCommand.execute(['--source=HEAD~1', 'file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockGit.checkout).toHaveBeenCalledWith(expect.objectContaining({
      ref: 'HEAD~1',
    }));
  });
});
