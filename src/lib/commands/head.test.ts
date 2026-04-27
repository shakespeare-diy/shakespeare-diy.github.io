import { describe, it, expect, beforeEach } from 'vitest';
import { HeadCommand } from './head';
import type { JSRuntimeFS } from '../JSRuntime';

// Mock filesystem
const mockFS = {
  stat: async (path: string) => {
    if (path === '/project/test.txt') {
      return { isFile: () => true, isDirectory: () => false };
    }
    if (path === '/project/dir') {
      return { isFile: () => false, isDirectory: () => true };
    }
    throw new Error('ENOENT: not found');
  },
  readFile: async (path: string, _encoding: string) => {
    if (path === '/project/test.txt') {
      return 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\n';
    }
    throw new Error('ENOENT: not found');
  },
} as unknown as JSRuntimeFS;

describe('HeadCommand', () => {
  let command: HeadCommand;

  beforeEach(() => {
    command = new HeadCommand(mockFS);
  });

  it('should have correct name and description', () => {
    expect(command.name).toBe('head');
    expect(command.description).toBe('Display the first lines of files');
    expect(command.usage).toBe('head [-n NUM] [-c NUM] [-qv] [--] [file...]');
  });

  it('should show first 10 lines by default', async () => {
    const result = await command.execute(['test.txt'], '/project');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n');
  });

  it('should show custom number of lines with -n', async () => {
    const result = await command.execute(['-n', '3', 'test.txt'], '/project');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1\nline 2\nline 3\n');
  });

  it('should show custom number of lines with -n3 format', async () => {
    const result = await command.execute(['-n3', 'test.txt'], '/project');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1\nline 2\nline 3\n');
  });

  it('should handle file not found', async () => {
    const result = await command.execute(['nonexistent.txt'], '/project');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No such file or directory');
  });

  it('should handle directory error', async () => {
    const result = await command.execute(['dir'], '/project');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Is a directory');
  });

  it('should accept absolute paths', async () => {
    const result = await command.execute(['/project/test.txt'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('line 1');
  });

  it('should read from stdin via - when piped input is provided', async () => {
    const result = await command.execute(['-n', '2', '-'], '/project', 'a\nb\nc\nd\n');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('a\nb\n');
  });

  it('should support -NUM shorthand', async () => {
    const result = await command.execute(['-3', 'test.txt'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1\nline 2\nline 3\n');
  });

  it('should support --lines=NUM long form', async () => {
    const result = await command.execute(['--lines=2', 'test.txt'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1\nline 2\n');
  });

  it('should support -c for bytes', async () => {
    const result = await command.execute(['-c', '6', 'test.txt'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1');
  });
});