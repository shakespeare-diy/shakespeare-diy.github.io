import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitRevertCommand } from './revert';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const mockFS = {
  stat: async (path: string) => {
    if (path.endsWith('/.git')) return { isDirectory: () => true };
    throw new Error('ENOENT');
  },
  writeFile: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
} as unknown as JSRuntimeFS;

describe('GitRevertCommand', () => {
  let revertCommand: GitRevertCommand;
  let mockGit: Git;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGit = {
      resolveRef: vi.fn().mockResolvedValue('abc123'),
      readCommit: vi.fn().mockResolvedValue({
        oid: 'abc123',
        commit: {
          message: 'Add file2',
          parent: ['parent123'],
          author: { name: 'Test', email: 'test@example.com', timestamp: 1 },
        },
      }),
      readTree: vi.fn().mockImplementation(({ oid }: { oid: string }) => {
        if (oid === 'abc123') {
          return Promise.resolve({ tree: [
            { mode: '100644', path: 'file1.txt', oid: 'blob1' },
            { mode: '100644', path: 'file2.txt', oid: 'blob2' },
          ] });
        }
        if (oid === 'parent123') {
          return Promise.resolve({ tree: [
            { mode: '100644', path: 'file1.txt', oid: 'blob1' },
          ] });
        }
        return Promise.resolve({ tree: [] });
      }),
      readBlob: vi.fn().mockResolvedValue({
        oid: 'blob1',
        blob: new TextEncoder().encode('original'),
      }),
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      commit: vi.fn().mockResolvedValue('newcommit'),
      currentBranch: vi.fn().mockResolvedValue('main'),
    } as unknown as Git;
    revertCommand = new GitRevertCommand({ git: mockGit, fs: mockFS });
  });

  it('should fail without commit argument', async () => {
    const result = await revertCommand.execute([], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('empty commit set');
  });

  it('should fail when not in a git repo', async () => {
    const mockFSNoGit = {
      stat: async () => { throw new Error('ENOENT'); },
    } as unknown as JSRuntimeFS;
    const cmd = new GitRevertCommand({ git: mockGit, fs: mockFSNoGit });
    const result = await cmd.execute(['HEAD'], '/not-a-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  it('should fail when reverting a root commit', async () => {
    vi.mocked(mockGit.readCommit).mockResolvedValue({
      oid: 'abc123',
      commit: {
        message: 'Root',
        parent: [],
        author: { name: 'Test', email: 'test@example.com', timestamp: 1 },
      },
    } as unknown as Awaited<ReturnType<Git['readCommit']>>);
    const result = await revertCommand.execute(['HEAD'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('root commit');
  });

  it('should revert a commit that added a file', async () => {
    const result = await revertCommand.execute(['HEAD'], '/test-repo');
    expect(result.exitCode).toBe(0);
    // file2.txt was added in target, so it should be removed
    expect(mockGit.remove).toHaveBeenCalledWith({ dir: '/test-repo', filepath: 'file2.txt' });
    expect(mockGit.commit).toHaveBeenCalled();
  });

  it('should support --no-commit', async () => {
    const result = await revertCommand.execute(['--no-commit', 'HEAD'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Applied revert');
    expect(mockGit.commit).not.toHaveBeenCalled();
  });
});
