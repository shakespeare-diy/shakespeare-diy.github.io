import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitRmCommand } from './rm';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const createMockFS = () => {
  const files = new Map<string, string>();
  const dirs = new Set(['/test-repo', '/test-repo/subdir']);
  files.set('/test-repo/file1.txt', 'contents');
  files.set('/test-repo/subdir/nested.txt', 'nested');

  return {
    stat: vi.fn(async (path: string) => {
      if (path.endsWith('/.git') || dirs.has(path)) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (files.has(path)) {
        return { isDirectory: () => false, isFile: () => true };
      }
      throw new Error('ENOENT');
    }),
    readdir: vi.fn(async (path: string) => {
      if (path === '/test-repo/subdir') {
        return [{ name: 'nested.txt', isDirectory: () => false, isFile: () => true }];
      }
      return [];
    }),
    unlink: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    _files: files,
  } as unknown as JSRuntimeFS & { _files: Map<string, string> };
};

describe('GitRmCommand', () => {
  let rmCommand: GitRmCommand;
  let mockGit: Git;
  let mockFS: JSRuntimeFS & { _files: Map<string, string> };

  beforeEach(() => {
    mockFS = createMockFS() as JSRuntimeFS & { _files: Map<string, string> };
    mockGit = {
      remove: vi.fn(async () => {}),
    } as unknown as Git;
    rmCommand = new GitRmCommand({ git: mockGit, fs: mockFS });
  });

  it('should fail without pathspec', async () => {
    const result = await rmCommand.execute([], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No pathspec');
  });

  it('should fail when not in a git repo', async () => {
    const mockFSNoGit = {
      stat: async () => { throw new Error('ENOENT'); },
    } as unknown as JSRuntimeFS;
    const cmd = new GitRmCommand({ git: mockGit, fs: mockFSNoGit });
    const result = await cmd.execute(['foo.txt'], '/not-a-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  it('should remove a file from working tree and index', async () => {
    const result = await rmCommand.execute(['file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rm 'file1.txt'");
    expect(mockGit.remove).toHaveBeenCalledWith({ dir: '/test-repo', filepath: 'file1.txt' });
    expect(mockFS.unlink).toHaveBeenCalled();
  });

  it('should only remove from index with --cached', async () => {
    const result = await rmCommand.execute(['--cached', 'file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockGit.remove).toHaveBeenCalled();
    expect(mockFS.unlink).not.toHaveBeenCalled();
  });

  it('should not remove files with --dry-run', async () => {
    const result = await rmCommand.execute(['-n', 'file1.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rm 'file1.txt'");
    expect(mockGit.remove).not.toHaveBeenCalled();
  });

  it('should require -r for directories', async () => {
    const result = await rmCommand.execute(['subdir'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('-r');
  });

  it('should remove directory recursively with -r', async () => {
    const result = await rmCommand.execute(['-r', 'subdir'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('subdir/nested.txt');
  });
});
