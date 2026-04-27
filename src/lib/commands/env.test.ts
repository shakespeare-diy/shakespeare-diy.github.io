import { describe, it, expect } from 'vitest';
import { EnvCommand } from './env';

describe('EnvCommand', () => {
  const envCommand = new EnvCommand();

  it('should display default environment variables', async () => {
    const result = await envCommand.execute([], '/test/dir');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('HOME=/');
    expect(result.stdout).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
    expect(result.stdout).toContain('SHELL=/bin/sh');
    expect(result.stdout).toContain('USER=user');
    expect(result.stdout).toContain('PWD=/test/dir');
    expect(result.stdout).toContain('TERM=xterm-256color');
    expect(result.stdout).toContain('LANG=en_US.UTF-8');
    expect(result.stderr).toBe('');
  });

  it('should show current working directory in PWD', async () => {
    const result = await envCommand.execute([], '/different/path');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PWD=/different/path');
    expect(result.stderr).toBe('');
  });

  it('should support NAME=VALUE assignments', async () => {
    const result = await envCommand.execute(['FOO=bar'], '/test');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('FOO=bar');
  });

  it('should support -i to start with empty env', async () => {
    const result = await envCommand.execute(['-i', 'ONLY=this'], '/test');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ONLY=this');
    expect(result.stdout).not.toContain('PATH=');
  });

  it('should support -u to unset a variable', async () => {
    const result = await envCommand.execute(['-u', 'PATH'], '/test');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('PATH=');
    expect(result.stdout).toContain('HOME=');
  });

  it('should read from envSource when provided', async () => {
    const cmd = new EnvCommand();
    cmd.envSource = () => ({ CUSTOM: 'yes', FOO: 'bar' });
    const result = await cmd.execute([], '/test');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('CUSTOM=yes');
    expect(result.stdout).toContain('FOO=bar');
  });
});
