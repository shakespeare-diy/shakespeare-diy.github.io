import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { parseOptions } from "./utils";

/**
 * Implementation of the 'pwd' command.
 *
 * Supported options:
 *   -L   Print the value of $PWD, resolving symbolic links (default)
 *   -P   Print the physical directory, without symlinks
 *
 * In our VFS there are no symlinks, so both behave identically.
 */
export class PwdCommand implements ShellCommand {
  name = 'pwd';
  description = 'Print working directory';
  usage = 'pwd [-LP]';

  async execute(args: string[], cwd: string, _input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['L', 'P'],
    });
    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }
    if (parsed.operands.length > 0) {
      return createErrorResult(`${this.name}: too many arguments`);
    }
    return createSuccessResult(cwd + '\n');
  }
}
