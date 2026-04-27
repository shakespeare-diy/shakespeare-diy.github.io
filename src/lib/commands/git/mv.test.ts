import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitMvCommand } from './mv';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const createMockFS = () => {
  const files = new Map<string, string>();
  const dirs = new Set(['/test-repo', '/test-repo/dir']);
  files.set('/test-repo/file1.txt', 'contents');

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
    rename: vi.fn(async (src: string, dst: string) => {
      const content = files.get(src);
      if (content === undefined) throw new Error('ENOENT');
      files.delete(src);
      files.set(dst, content);
    }),
    mkdir: vi.fn(async (path: string) => { dirs.add(path); }),
    readFile: vi.fn(async (path: string) => files.get(path) || ''),
    _files: files,
  } as unknown as JSRuntimeFS & { _files: Map<string, string> };
};

describe('GitMvCommand', () => {
  let mvCommand: GitMvCommand;
  let mockGit: Git;
  let mockFS: JSRuntimeFS & { _files: Map<string, string> };

  beforeEach(() => {
    mockFS = createMockFS() as JSRuntimeFS & { _files: Map<string, string> };
    mockGit = {
      remove: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
    } as unknown as Git;
    mvCommand = new GitMvCommand({ git: mockGit, fs: mockFS });
  });

  it('should fail without arguments', async () => {
    const result = await mvCommand.execute([], '/test-repo');
    expect(result.exitCode).toBe(1);
  });

  it('should rename a file', async () => {
    const result = await mvCommand.execute(['file1.txt', 'file2.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockFS.rename).toHaveBeenCalledWith('/test-repo/file1.txt', '/test-repo/file2.txt');
    expect(mockGit.remove).toHaveBeenCalledWith({ dir: '/test-repo', filepath: 'file1.txt' });
    expect(mockGit.add).toHaveBeenCalledWith({ dir: '/test-repo', filepath: 'file2.txt' });
  });

  it('should fail when source does not exist', async () => {
    const result = await mvCommand.execute(['nonexistent.txt', 'new.txt'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bad source');
  });

  it('should fail when destination exists without --force', async () => {
    mockFS._files.set('/test-repo/file2.txt', 'existing');
    const result = await mvCommand.execute(['file1.txt', 'file2.txt'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('destination exists');
  });

  it('should overwrite with --force', async () => {
    mockFS._files.set('/test-repo/file2.txt', 'existing');
    const result = await mvCommand.execute(['-f', 'file1.txt', 'file2.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
  });

  it('should support --dry-run', async () => {
    const result = await mvCommand.execute(['-n', 'file1.txt', 'file2.txt'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Renaming');
    expect(mockFS.rename).not.toHaveBeenCalled();
  });

  it('should move a file into a directory', async () => {
    const result = await mvCommand.execute(['file1.txt', 'dir'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockFS.rename).toHaveBeenCalledWith('/test-repo/file1.txt', '/test-repo/dir/file1.txt');
  });
});
