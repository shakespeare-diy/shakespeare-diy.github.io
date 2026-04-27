import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitMergeCommand } from './merge';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const mockFS = {
  stat: async (path: string) => {
    if (path.endsWith('/.git')) return { isDirectory: () => true };
    throw new Error('ENOENT');
  },
} as unknown as JSRuntimeFS;

describe('GitMergeCommand', () => {
  let mergeCommand: GitMergeCommand;
  let mockGit: Git;

  beforeEach(() => {
    mockGit = {
      currentBranch: vi.fn().mockResolvedValue('main'),
      merge: vi.fn().mockResolvedValue({ fastForward: true }),
      abortMerge: vi.fn(async () => {}),
    } as unknown as Git;
    mergeCommand = new GitMergeCommand({ git: mockGit, fs: mockFS });
  });

  it('should fail with no commits', async () => {
    const result = await mergeCommand.execute([], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No commit specified');
  });

  it('should fail when not in a git repo', async () => {
    const mockFSNoGit = {
      stat: async () => { throw new Error('ENOENT'); },
    } as unknown as JSRuntimeFS;
    const cmd = new GitMergeCommand({ git: mockGit, fs: mockFSNoGit });
    const result = await cmd.execute(['main'], '/not-a-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  it('should report already up to date when alreadyMerged', async () => {
    vi.mocked(mockGit.merge).mockResolvedValue({ alreadyMerged: true } as unknown as Awaited<ReturnType<Git['merge']>>);
    const result = await mergeCommand.execute(['other'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Already up to date');
  });

  it('should report fast-forward', async () => {
    vi.mocked(mockGit.merge).mockResolvedValue({ fastForward: true } as unknown as Awaited<ReturnType<Git['merge']>>);
    const result = await mergeCommand.execute(['other'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Fast-forward');
  });

  it('should call abortMerge with --abort', async () => {
    const result = await mergeCommand.execute(['--abort'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(mockGit.abortMerge).toHaveBeenCalled();
  });

  it('should pass --ff-only to merge', async () => {
    await mergeCommand.execute(['--ff-only', 'other'], '/test-repo');
    expect(mockGit.merge).toHaveBeenCalledWith(expect.objectContaining({
      fastForwardOnly: true,
    }));
  });
});
