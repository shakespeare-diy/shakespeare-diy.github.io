import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult } from "./ShellCommand";

/**
 * Implementation of the 'echo' command.
 *
 * Supported options:
 *   -n    Do not output the trailing newline
 *   -e    Enable interpretation of backslash escapes
 *   -E    Disable interpretation of backslash escapes (default)
 *
 * Supported escape sequences (with -e):
 *   \\, \a, \b, \c (suppress further output + newline), \e, \f,
 *   \n, \r, \t, \v, \0NNN (octal), \xHH (hex)
 */
export class EchoCommand implements ShellCommand {
  name = 'echo';
  description = 'Display text';
  usage = 'echo [-neE] [text...]';

  async execute(args: string[], _cwd: string, _input?: string): Promise<ShellCommandResult> {
    // POSIX echo's argument parsing is very conservative: it stops treating
    // args as options the moment one is not a recognized flag group. This
    // matches the bash builtin.
    let newline = true;
    let interpret = false;
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (!/^-[neE]+$/.test(arg)) break;
      for (const ch of arg.slice(1)) {
        if (ch === 'n') newline = false;
        else if (ch === 'e') interpret = true;
        else if (ch === 'E') interpret = false;
      }
      i++;
    }

    const rest = args.slice(i).join(' ');
    let output = interpret ? interpretEscapes(rest) : rest;

    // \c in -e suppresses the trailing newline.
    if (interpret && output.indexOf('\u0000CSUPPRESS\u0000') !== -1) {
      output = output.slice(0, output.indexOf('\u0000CSUPPRESS\u0000'));
      newline = false;
    }

    return createSuccessResult(output + (newline ? '\n' : ''));
  }
}

function interpretEscapes(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      i++;
      continue;
    }
    const next = s[i + 1];
    switch (next) {
      case '\\': out += '\\'; i += 2; break;
      case 'a':  out += '\x07'; i += 2; break;
      case 'b':  out += '\b'; i += 2; break;
      case 'c':
        // Marker: caller truncates at this sentinel and suppresses newline.
        out += '\u0000CSUPPRESS\u0000';
        i += 2;
        break;
      case 'e':  out += '\x1b'; i += 2; break;
      case 'f':  out += '\f'; i += 2; break;
      case 'n':  out += '\n'; i += 2; break;
      case 'r':  out += '\r'; i += 2; break;
      case 't':  out += '\t'; i += 2; break;
      case 'v':  out += '\v'; i += 2; break;
      case '0': {
        // \0NNN octal (up to 3 digits)
        let j = i + 2;
        let oct = '';
        while (j < s.length && oct.length < 3 && /[0-7]/.test(s[j])) {
          oct += s[j];
          j++;
        }
        out += oct ? String.fromCharCode(parseInt(oct, 8)) : '\0';
        i = j;
        break;
      }
      case 'x': {
        let j = i + 2;
        let hex = '';
        while (j < s.length && hex.length < 2 && /[0-9a-fA-F]/.test(s[j])) {
          hex += s[j];
          j++;
        }
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16));
          i = j;
        } else {
          out += '\\x';
          i += 2;
        }
        break;
      }
      default:
        out += '\\' + next;
        i += 2;
    }
  }
  return out;
}
