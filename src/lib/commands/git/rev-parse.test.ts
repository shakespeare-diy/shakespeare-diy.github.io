import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitRevParseCommand } from './rev-parse';
import type { Git } from '../../git';
import type { JSRuntimeFS } from '../../JSRuntime';

const mockFS = {
  stat: async (path: string) => {
    if (path.endsWith('/.git')) return { isDirectory: () => true };
    throw new Error('ENOENT');
  },
} as unknown as JSRuntimeFS;

describe('GitRevParseCommand', () => {
  let revParseCommand: GitRevParseCommand;
  let mockGit: Git;

  beforeEach(() => {
    mockGit = {
      resolveRef: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
        if (ref === 'HEAD') return Promise.resolve('abcdef0123456789abcdef0123456789abcdef01');
        if (ref === 'main') return Promise.resolve('abcdef0123456789abcdef0123456789abcdef01');
        throw new Error('unknown ref');
      }),
      readCommit: vi.fn().mockResolvedValue({
        oid: 'abcdef0123456789abcdef0123456789abcdef01',
        commit: { parent: ['parent123parent123parent123parent123parent'] },
      }),
      currentBranch: vi.fn().mockResolvedValue('main'),
    } as unknown as Git;
    revParseCommand = new GitRevParseCommand({ git: mockGit, fs: mockFS });
  });

  it('should resolve HEAD to full commit hash', async () => {
    const result = await revParseCommand.execute(['HEAD'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  });

  it('should abbreviate with --short', async () => {
    const result = await revParseCommand.execute(['--short', 'HEAD'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[a-f0-9]{7}$/);
  });

  it('should abbreviate with --short=<n>', async () => {
    const result = await revParseCommand.execute(['--short=4', 'HEAD'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[a-f0-9]{4}$/);
  });

  it('should resolve HEAD~1', async () => {
    const result = await revParseCommand.execute(['HEAD~1'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('parent123parent123parent123parent123parent');
  });

  it('should return main with --abbrev-ref HEAD', async () => {
    const result = await revParseCommand.execute(['--abbrev-ref', 'HEAD'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('main');
  });

  it('should output toplevel with --show-toplevel', async () => {
    const result = await revParseCommand.execute(['--show-toplevel'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/test-repo');
  });

  it('should output git dir with --git-dir', async () => {
    const result = await revParseCommand.execute(['--git-dir'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/test-repo/.git');
  });

  it('should output true with --is-inside-work-tree', async () => {
    const result = await revParseCommand.execute(['--is-inside-work-tree'], '/test-repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('true');
  });

  it('should fail for invalid revisions', async () => {
    const result = await revParseCommand.execute(['notarevision'], '/test-repo');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ambiguous argument');
  });
});
