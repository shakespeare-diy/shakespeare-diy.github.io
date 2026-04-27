import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitSwitchCommand } from './switch';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const mockFS = {
  stat: async (path: string) => {
    if (path.endsWith('/.git')) return { isDirectory: () => true };
    throw new Error('ENOENT');
  },
} as unknown as JSRuntimeFS;

describe('GitSwitchCommand', () => {
  let switchCommand: GitSwitchCommand;
  let mockGit: Git;

  beforeEach(() => {
    mockGit = {
      listBranches: vi.fn().mockResolvedValue(['main', 'other']),
      currentBranch: vi.fn().mockResolvedValue('main'),
      checkout: vi.fn(async () => {}),
      branch: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
      resolveRef: vi.fn().mockResolvedValue('abc123'),
      statusMatrix: vi.fn().mockResolvedValue([]),
    } as unknown as Git;
    switchCommand = new GitSwitchCommand({ git: mockGit, fs: mockFS });
  });

  it('should create and switch with -c', async () => {
    vi.mocked(mockGit.listBranches).mockResolvedValue(['main']);
    const result = await switchCommand.execute(['-c', 'feature'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to a new branch 'feature'");
    expect(mockGit.branch).toHaveBeenCalled();
  });

  it('should switch to existing branch', async () => {
    const result = await switchCommand.execute(['other'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to branch 'other'");
  });

  it('should fail for non-existent branch', async () => {
    const result = await switchCommand.execute(['nonexistent'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid reference');
  });

  it('should say already on branch', async () => {
    const result = await switchCommand.execute(['main'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already on 'main'");
  });

  it('should fail when not in a git repo', async () => {
    const mockFSNoGit = {
      stat: async () => { throw new Error('ENOENT'); },
    } as unknown as JSRuntimeFS;
    const cmd = new GitSwitchCommand({ git: mockGit, fs: mockFSNoGit });
    const result = await cmd.execute(['main'], '/not-a-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  it('should block switch with uncommitted changes', async () => {
    vi.mocked(mockGit.statusMatrix).mockResolvedValue([
      ['file.txt', 1, 2, 1],
    ]);
    const result = await switchCommand.execute(['other'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('local changes');
  });

  it('should force switch with -f', async () => {
    vi.mocked(mockGit.statusMatrix).mockResolvedValue([
      ['file.txt', 1, 2, 1],
    ]);
    const result = await switchCommand.execute(['-f', 'other'], '/test-repo');
    expect(result.exitCode).toBe(0);
  });
});
