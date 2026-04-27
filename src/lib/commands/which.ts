import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { parseOptions } from "./utils";

/**
 * Implementation of the 'which' command.
 *
 * Supported options:
 *   -a   Print all matching pathnames (only ever one per name in our registry)
 *   -s   Silent mode — no output, only exit status
 *   --   End of options
 */
export class WhichCommand implements ShellCommand {
  name = 'which';
  description = 'Locate a command';
  usage = 'which [-as] [--] command...';

  private commands: Map<string, ShellCommand>;

  constructor(commands: Map<string, ShellCommand>) {
    this.commands = commands;
  }

  async execute(args: string[], _cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['a', 's'],
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    if (parsed.operands.length === 0) {
      return createErrorResult(`${this.name}: missing operand`);
    }

    const silent = parsed.flags.has('s');
    const results: string[] = [];
    let hasError = false;

    for (const commandName of parsed.operands) {
      if (this.commands.has(commandName)) {
        results.push(`/usr/bin/${commandName}`);
      } else {
        if (!silent) results.push(`${this.name}: no ${commandName} in (/usr/bin)`);
        hasError = true;
      }
    }

    if (silent) {
      return hasError
        ? { exitCode: 1, stdout: '', stderr: '' }
        : createSuccessResult('');
    }

    const output = results.join('\n') + (results.length > 0 ? '\n' : '');
    return hasError ? createErrorResult(output, 1) : createSuccessResult(output);
  }
}
