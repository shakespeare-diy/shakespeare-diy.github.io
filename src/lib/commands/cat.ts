import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand, ShellCommandResult } from "./ShellCommand";
import { createSuccessResult, createErrorResult } from "./ShellCommand";
import { classifyFsError, parseOptions, resolvePath } from "./utils";

/**
 * Implementation of the 'cat' command.
 *
 * Concatenate files and/or standard input to standard output.
 *
 * Supported options (POSIX + common GNU extensions):
 *   -n            Number all output lines (1-based)
 *   -b            Number non-empty output lines only
 *   -s            Squeeze multiple blank lines into one
 *   -E            Display $ at end of each line
 *   -T            Display tabs as ^I
 *   -A            Equivalent to -vET (minus control-char rendering for -v)
 *   -v            Display non-printing characters as ^X or M-X
 *   -u            POSIX: unbuffered (accepted, no-op)
 *   --            End of options
 *   -             Read from standard input at this position
 */
export class CatCommand implements ShellCommand {
  name = 'cat';
  description = 'Concatenate and display file contents';
  usage = 'cat [-nbsETAvu] [--] [file...]';

  private fs: JSRuntimeFS;

  constructor(fs: JSRuntimeFS) {
    this.fs = fs;
  }

  async execute(args: string[], cwd: string, input?: string): Promise<ShellCommandResult> {
    const parsed = parseOptions(args, {
      booleanShort: ['n', 'b', 's', 'E', 'T', 'A', 'v', 'u'],
    });

    if (parsed.unknown.length > 0) {
      return createErrorResult(`${this.name}: invalid option -- '${parsed.unknown[0].replace(/^-+/, '')}'`);
    }

    // -A implies -vET
    if (parsed.flags.has('A')) {
      parsed.flags.add('v');
      parsed.flags.add('E');
      parsed.flags.add('T');
    }

    // If no file operands (and no explicit `-`), default to stdin when input is provided,
    // otherwise POSIX `cat` with no args reads stdin — we mirror that for pipelines.
    const operands = parsed.operands.length > 0 ? parsed.operands : ['-'];

    let combined = '';
    for (const filePath of operands) {
      if (filePath === '-') {
        if (input === undefined) {
          // No piped input and an explicit `-`: POSIX says read stdin; in our
          // non-interactive environment, treat as empty.
          continue;
        }
        combined += input;
        continue;
      }

      try {
        const absolutePath = resolvePath(filePath, cwd);
        const stats = await this.fs.stat(absolutePath);
        if (stats.isDirectory()) {
          return createErrorResult(`${this.name}: ${filePath}: Is a directory`);
        }
        const content = await this.fs.readFile(absolutePath, 'utf8');
        combined += content;
      } catch (error) {
        const { kind } = classifyFsError(error);
        if (kind === 'ENOENT') {
          return createErrorResult(`${this.name}: ${filePath}: No such file or directory`);
        }
        if (kind === 'EACCES') {
          return createErrorResult(`${this.name}: ${filePath}: Permission denied`);
        }
        return createErrorResult(`${this.name}: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // If no processing options are set, return raw content fast-path.
    if (
      !parsed.flags.has('n') &&
      !parsed.flags.has('b') &&
      !parsed.flags.has('s') &&
      !parsed.flags.has('E') &&
      !parsed.flags.has('T') &&
      !parsed.flags.has('v')
    ) {
      return createSuccessResult(combined);
    }

    const output = this.applyFilters(combined, parsed.flags);
    return createSuccessResult(output);
  }

  private applyFilters(content: string, flags: Set<string>): string {
    const hadTrailingNewline = content.endsWith('\n');
    const bodyLines = (hadTrailingNewline ? content.slice(0, -1) : content).split('\n');

    // -s: squeeze consecutive blank lines
    let lines = bodyLines;
    if (flags.has('s')) {
      const squeezed: string[] = [];
      let prevBlank = false;
      for (const line of lines) {
        const isBlank = line === '';
        if (isBlank && prevBlank) continue;
        squeezed.push(line);
        prevBlank = isBlank;
      }
      lines = squeezed;
    }

    // -v: render non-printing characters
    if (flags.has('v')) {
      lines = lines.map((l) => renderNonPrinting(l, flags.has('T')));
    }

    // -T: show tabs as ^I
    if (flags.has('T')) {
      lines = lines.map((l) => l.replace(/\t/g, '^I'));
    }

    // -E: end-of-line markers
    if (flags.has('E')) {
      lines = lines.map((l) => l + '$');
    }

    // -n / -b: line numbering (-b wins over -n)
    if (flags.has('b')) {
      let n = 0;
      lines = lines.map((l) => {
        // -b numbers nonblank lines. With -E, $ was appended; check original blankness.
        const original = flags.has('E') ? l.slice(0, -1) : l;
        if (original === '') return '\t' + l;
        n++;
        return String(n).padStart(6) + '\t' + l;
      });
    } else if (flags.has('n')) {
      lines = lines.map((l, idx) => String(idx + 1).padStart(6) + '\t' + l);
    }

    return lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  }
}

function renderNonPrinting(line: string, skipTab: boolean): string {
  let out = '';
  for (const ch of line) {
    const code = ch.charCodeAt(0);
    if (skipTab && ch === '\t') {
      out += ch;
      continue;
    }
    if (code < 32 && ch !== '\t') {
      out += '^' + String.fromCharCode(code + 64);
    } else if (code === 127) {
      out += '^?';
    } else if (code >= 128 && code < 160) {
      out += 'M-^' + String.fromCharCode(code - 128 + 64);
    } else if (code >= 160 && code < 256) {
      out += 'M-' + String.fromCharCode(code - 128);
    } else {
      out += ch;
    }
  }
  return out;
}
