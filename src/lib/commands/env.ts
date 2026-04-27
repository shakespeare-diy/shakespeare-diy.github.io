import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { parseOptions } from "./utils";

/**
 * Implementation of the 'env' command.
 *
 * Supported options:
 *   -i, --ignore-environment    Start with an empty environment
 *   -u NAME, --unset=NAME       Remove NAME from the environment
 *   -0, --null                  End each output line with NUL, not newline
 *   --                          End of options
 *
 * Synopsis:
 *   env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]
 *
 * This implementation prints the (optionally modified) environment and
 * supports NAME=VALUE prefixes. It does not exec commands because the
 * shell integration runs each command through the registry; the COMMAND
 * form is handled by the shell executor's command-prefix assignment.
 */
export class EnvCommand implements ShellCommand {
  name = 'env';
  description = 'Display environment variables';
  usage = 'env [-i] [-u NAME] [-0] [--] [NAME=VALUE]...';

  /**
   * Optional accessor that the shell tool may populate so `env` can reflect
   * the shell executor's current environment. When not supplied, falls back
   * to a small default set of vars.
   */
  envSource: (() => Record<string, string>) | undefined;

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['i', '0'],
      valueShort: ['u'],
      booleanLong: ['ignore-environment', 'null'],
      valueLong: ['unset'],
      longToShort: {
        'ignore-environment': 'i',
        null: '0',
        unset: 'u',
      },
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    // Collect all -u NAMEs (parseOptions only keeps the last; scan args).
    const unsets = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-u' || args[i] === '--unset') {
        if (i + 1 < args.length) unsets.add(args[++i]);
      } else if (args[i].startsWith('--unset=')) {
        unsets.add(args[i].slice('--unset='.length));
      }
    }

    const startFresh = parsed.flags.has('i');
    const nullTerm = parsed.flags.has('0');

    // Source environment
    let env: Record<string, string> = startFresh
      ? {}
      : (this.envSource?.() ?? defaultEnv(cwd));

    // Ensure PWD is set from the live cwd if no source.
    if (!this.envSource && !('PWD' in env)) env.PWD = cwd;

    // Remove requested unsets.
    for (const name of unsets) delete env[name];

    // Apply NAME=VAL overrides and consume them; remaining args are COMMAND ARGS
    // (which we do not exec).
    for (const operand of parsed.operands) {
      const eq = operand.indexOf('=');
      if (eq > 0) {
        const name = operand.slice(0, eq);
        const value = operand.slice(eq + 1);
        env = { ...env, [name]: value };
      } else {
        // Reaching a non-assignment means COMMAND — we do not exec; just stop
        // consuming assignments and print the accumulated env.
        break;
      }
    }

    const sep = nullTerm ? '\0' : '\n';
    const lines = Object.keys(env)
      .sort()
      .map((k) => `${k}=${env[k]}`);
    return createSuccessResult(lines.join(sep) + (lines.length > 0 ? sep : ''));
  }
}

function defaultEnv(cwd: string): Record<string, string> {
  return {
    HOME: '/',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/sh',
    USER: 'user',
    PWD: cwd,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
  };
}
