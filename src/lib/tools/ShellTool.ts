import { z } from "zod";
import { join } from "path-browserify";
import type { Tool, ToolResult } from "./Tool";
import type { JSRuntimeFS } from "../JSRuntime";
import type { ShellCommand } from "../commands/ShellCommand";
import { Git } from "../git";
import type { NostrSigner } from "@nostrify/nostrify";
import {
  CatCommand,
  CdCommand,
  ClearCommand,
  CpCommand,
  CurlCommand,
  CutCommand,
  DateCommand,
  DiffCommand,
  EchoCommand,
  EnvCommand,
  FindCommand,
  GitCommand,
  GrepCommand,
  HeadCommand,
  HexdumpCommand,
  LsCommand,
  MkdirCommand,
  MvCommand,
  PwdCommand,
  RmCommand,
  SedCommand,
  ShakespeareCommand,
  SortCommand,
  TailCommand,
  TouchCommand,
  TrCommand,
  UniqCommand,
  UnzipCommand,
  WcCommand,
  WhoamiCommand,
  WhichCommand
} from "../commands";

interface ShellToolParams {
  command: string;
}

/**
 * Shell tool that provides a command-line interface for basic file operations
 */
export class ShellTool implements Tool<ShellToolParams> {
  private fs: JSRuntimeFS;
  private cwd: string;
  private git: Git;
  private commands: Map<string, ShellCommand>;
  private signer?: NostrSigner;
  private corsProxy: string;

  readonly description = "Execute shell commands like cat, ls, cd, pwd, rm, cp, mv, echo, head, tail, grep, find, wc, touch, mkdir, sort, uniq, cut, tr, sed, diff, which, whoami, date, env, clear, git, curl, unzip, hexdump. Supports compound commands with &&, ||, ;, and | operators, and output redirection with > and >> operators";

  readonly inputSchema = z.object({
    command: z.string().describe(
      'Shell command to execute, e.g. "cat file.txt", "ls -la", "cd src", "pwd", "sort file.txt", "diff file1 file2", "git status", "git add .", "git commit -m \'message\'", "curl -X GET https://api.example.com", "curl -H \'Content-Type: application/json\' -d \'{"key":"value"}\' https://api.example.com". Supports compound commands with &&, ||, ;, and | operators, e.g. "pwd && ls -la", "cat file.txt | grep pattern", "git add . && git commit -m \'update\'". Also supports output redirection with > and >> operators, e.g. "echo hello > file.txt", "ls >> output.log"'
    ),
  });

  constructor(fs: JSRuntimeFS, cwd: string, git: Git, corsProxy: string, signer?: NostrSigner) {
    this.fs = fs;
    this.cwd = cwd;
    this.git = git;
    this.corsProxy = corsProxy;
    this.signer = signer;
    this.commands = new Map();

    // Register available commands
    this.registerCommand(new CatCommand(fs));
    this.registerCommand(new CdCommand(fs));
    this.registerCommand(new ClearCommand());
    this.registerCommand(new CpCommand(fs));
    this.registerCommand(new CurlCommand(fs, this.corsProxy));
    this.registerCommand(new CutCommand(fs));
    this.registerCommand(new DateCommand());
    this.registerCommand(new DiffCommand(fs));
    this.registerCommand(new EchoCommand());
    this.registerCommand(new EnvCommand());
    this.registerCommand(new FindCommand(fs));
    this.registerCommand(new GitCommand({ git: this.git, fs, cwd: this.cwd, signer: this.signer }));
    this.registerCommand(new GrepCommand(fs));
    this.registerCommand(new HeadCommand(fs));
    this.registerCommand(new HexdumpCommand(fs));
    this.registerCommand(new LsCommand(fs));
    this.registerCommand(new MkdirCommand(fs));
    this.registerCommand(new MvCommand(fs));
    this.registerCommand(new PwdCommand());
    this.registerCommand(new RmCommand(fs));
    this.registerCommand(new SedCommand(fs));
    this.registerCommand(new ShakespeareCommand());
    this.registerCommand(new SortCommand(fs));
    this.registerCommand(new TailCommand(fs));
    this.registerCommand(new TouchCommand(fs));
    this.registerCommand(new TrCommand(fs));
    this.registerCommand(new UniqCommand(fs));
    this.registerCommand(new UnzipCommand(fs));
    this.registerCommand(new WcCommand(fs));
    this.registerCommand(new WhoamiCommand());

    // Register which command last so it has access to all other commands
    this.registerCommand(new WhichCommand(this.commands));
  }

  /**
   * Register a shell command
   */
  private registerCommand(command: ShellCommand): void {
    this.commands.set(command.name, command);
  }

  /**
   * Parse a command string into command name, arguments, and redirection info.
   *
   * Returns tokens alongside a flag indicating whether each token was fully
   * quoted (so the caller knows whether glob expansion should apply).
   */
  private parseCommand(commandStr: string): {
    name: string;
    args: string[];
    argQuoted: boolean[];
    redirectType?: '>' | '>>';
    redirectFile?: string;
  } {
    // First, check for redirection operators
    let redirectType: '>' | '>>' | undefined;
    let redirectFile: string | undefined;
    let actualCommand = commandStr;

    // Look for redirection operators (outside of quotes)
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < commandStr.length; i++) {
      const char = commandStr[i];
      const nextChar = commandStr[i + 1];

      if (!inQuotes && (char === '"' || char === "'")) {
        inQuotes = true;
        quoteChar = char;
      } else if (inQuotes && char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else if (!inQuotes) {
        if (char === '>' && nextChar === '>') {
          // >> append redirection
          redirectType = '>>';
          actualCommand = commandStr.substring(0, i).trim();
          redirectFile = commandStr.substring(i + 2).trim();
          break;
        } else if (char === '>' && nextChar !== '>') {
          // > overwrite redirection
          redirectType = '>';
          actualCommand = commandStr.substring(0, i).trim();
          redirectFile = commandStr.substring(i + 1).trim();
          break;
        }
      }
    }

    // Remove quotes from redirect file if present
    if (redirectFile) {
      if ((redirectFile.startsWith('"') && redirectFile.endsWith('"')) ||
          (redirectFile.startsWith("'") && redirectFile.endsWith("'"))) {
        redirectFile = redirectFile.slice(1, -1);
      }
    }

    // Parse the actual command part, tracking whether each token was quoted.
    const parts: string[] = [];
    const partQuoted: boolean[] = [];
    let current = '';
    let currentHasQuotes = false;
    inQuotes = false;
    quoteChar = '';

    for (let i = 0; i < actualCommand.length; i++) {
      const char = actualCommand[i];

      if (!inQuotes && (char === '"' || char === "'")) {
        inQuotes = true;
        quoteChar = char;
        currentHasQuotes = true;
      } else if (inQuotes && char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else if (!inQuotes && char === ' ') {
        if (current.trim() || currentHasQuotes) {
          parts.push(current.trim());
          partQuoted.push(currentHasQuotes);
          current = '';
          currentHasQuotes = false;
        }
      } else {
        current += char;
      }
    }

    if (current.trim() || currentHasQuotes) {
      parts.push(current.trim());
      partQuoted.push(currentHasQuotes);
    }

    const [name = '', ...args] = parts;
    const argQuoted = partQuoted.slice(1);
    return { name, args, argQuoted, redirectType, redirectFile };
  }

  /**
   * Parse compound commands separated by &&, ||, ;, or |
   */
  private parseCompoundCommand(commandStr: string): Array<{ command: string; operator?: string }> {
    const commands: Array<{ command: string; operator?: string }> = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    let i = 0;

    while (i < commandStr.length) {
      const char = commandStr[i];
      const nextChar = commandStr[i + 1];

      if (!inQuotes && (char === '"' || char === "'")) {
        inQuotes = true;
        quoteChar = char;
        current += char;
      } else if (inQuotes && char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
        current += char;
      } else if (!inQuotes) {
        // Check for compound operators (but not redirection operators)
        if (char === '&' && nextChar === '&') {
          // && operator
          if (current.trim()) {
            commands.push({ command: current.trim(), operator: '&&' });
            current = '';
          }
          i++; // Skip next character
        } else if (char === '|' && nextChar === '|') {
          // || operator
          if (current.trim()) {
            commands.push({ command: current.trim(), operator: '||' });
            current = '';
          }
          i++; // Skip next character
        } else if (char === '|' && nextChar !== '|') {
          // | operator (pipe)
          if (current.trim()) {
            commands.push({ command: current.trim(), operator: '|' });
            current = '';
          }
        } else if (char === ';') {
          // ; operator
          if (current.trim()) {
            commands.push({ command: current.trim(), operator: ';' });
            current = '';
          }
        } else {
          current += char;
        }
      } else {
        current += char;
      }

      i++;
    }

    // Add the last command
    if (current.trim()) {
      commands.push({ command: current.trim() });
    }

    return commands;
  }

  /**
   * Expand glob patterns in command arguments against the virtual filesystem.
   *
   * Supports `*`, `?`, and `[...]` wildcards in any path segment. Patterns
   * that don't match any files are passed through unchanged (bash default
   * behaviour without `nullglob`). Quoted arguments are never expanded.
   * Arguments starting with `-` (option flags) are never expanded either.
   */
  private async expandGlobs(args: string[], quoted: boolean[]): Promise<string[]> {
    const result: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const wasQuoted = quoted[i] ?? false;

      if (wasQuoted || !this.hasGlobChars(arg) || arg.startsWith('-')) {
        result.push(arg);
        continue;
      }

      const matches = await this.expandSingleGlob(arg);
      if (matches.length > 0) {
        // Sort for deterministic order (matches bash behaviour).
        matches.sort();
        result.push(...matches);
      } else {
        // No matches: pass the literal pattern through (bash default).
        result.push(arg);
      }
    }

    return result;
  }

  /** True if the token contains unescaped glob metacharacters. */
  private hasGlobChars(token: string): boolean {
    return /[*?[]/.test(token);
  }

  /** Expand a single glob token to a list of matching paths. */
  private async expandSingleGlob(pattern: string): Promise<string[]> {
    // Split pattern into segments while preserving a leading slash for absolute paths.
    const isAbsolute = pattern.startsWith('/');
    const segments = (isAbsolute ? pattern.slice(1) : pattern).split('/');

    // Fast path: no segment contains wildcards.
    if (!segments.some((s) => this.hasGlobChars(s))) {
      return [pattern];
    }

    // Walk segment-by-segment, expanding matches.
    let candidates: string[] = [isAbsolute ? '/' : ''];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      const next: string[] = [];

      for (const base of candidates) {
        if (!this.hasGlobChars(segment)) {
          // Literal segment: just append.
          const combined = this.joinPath(base, segment);
          next.push(combined);
          continue;
        }

        // Wildcard segment: read the directory and filter.
        const dirPath = this.resolveForListing(base);
        let entries: string[];
        try {
          entries = await this.fs.readdir(dirPath);
        } catch {
          // Directory doesn't exist or isn't readable; this branch dies.
          continue;
        }

        const regex = this.globToRegex(segment);
        for (const entry of entries) {
          // Skip hidden files unless the pattern explicitly starts with a dot.
          if (entry.startsWith('.') && !segment.startsWith('.')) continue;
          if (!regex.test(entry)) continue;

          const combined = this.joinPath(base, entry);

          if (!isLast) {
            // Intermediate segment must be a directory.
            try {
              const stats = await this.fs.stat(this.resolveForListing(combined));
              if (!stats.isDirectory()) continue;
            } catch {
              continue;
            }
          }

          next.push(combined);
        }
      }

      candidates = next;
      if (candidates.length === 0) break;
    }

    return candidates;
  }

  /** Join a base path and a segment, preserving relative vs absolute form. */
  private joinPath(base: string, segment: string): string {
    if (!base) return segment;
    if (base === '/') return '/' + segment;
    if (!segment) return base;
    return base + '/' + segment;
  }

  /** Resolve a (possibly relative) path to an absolute one for fs operations. */
  private resolveForListing(p: string): string {
    if (!p) return this.cwd;
    if (p.startsWith('/')) return p;
    return join(this.cwd, p);
  }

  /** Convert a shell glob segment to a RegExp. */
  private globToRegex(glob: string): RegExp {
    let regex = '^';
    let i = 0;
    while (i < glob.length) {
      const ch = glob[i];
      if (ch === '*') {
        regex += '[^/]*';
      } else if (ch === '?') {
        regex += '[^/]';
      } else if (ch === '[') {
        // Character class: copy until closing ]
        const close = glob.indexOf(']', i + 1);
        if (close === -1) {
          regex += '\\[';
        } else {
          let cls = glob.slice(i + 1, close);
          if (cls.startsWith('!')) cls = '^' + cls.slice(1);
          regex += '[' + cls + ']';
          i = close;
        }
      } else if ('.+^$(){}|\\'.includes(ch)) {
        regex += '\\' + ch;
      } else {
        regex += ch;
      }
      i++;
    }
    regex += '$';
    return new RegExp(regex);
  }

  /**
   * Execute a single command and return the result
   */
  private async executeSingleCommand(commandStr: string, input?: string): Promise<{ stdout: string; stderr: string; exitCode: number; newCwd?: string }> {
    const { name, args: cmdArgs, argQuoted, redirectType, redirectFile } = this.parseCommand(commandStr);

    if (!name) {
      return { stdout: '', stderr: 'Error: No command specified', exitCode: 1 };
    }

    // Check if command exists
    const command = this.commands.get(name);
    if (!command) {
      const availableCommands = Array.from(this.commands.keys()).join(', ');
      return {
        stdout: '',
        stderr: `Error: Command '${name}' not found\nAvailable commands: ${availableCommands}`,
        exitCode: 127
      };
    }

    // Perform glob expansion on unquoted arguments (bash-style).
    // Commands that manage their own glob semantics (e.g. `find -name "*.ts"`)
    // still work because quoted patterns are not expanded here.
    const expandedArgs = await this.expandGlobs(cmdArgs, argQuoted);

    try {
      // Execute the command
      const result = await command.execute(expandedArgs, this.cwd, input);

      // Handle redirection if specified
      if (redirectType && redirectFile) {
        try {
          await this.handleRedirection(result.stdout, redirectType, redirectFile);
          // For redirection, we don't output to stdout
          return {
            stdout: '',
            stderr: result.stderr || '',
            exitCode: result.exitCode,
            newCwd: result.newCwd,
          };
        } catch (redirectError) {
          return {
            stdout: '',
            stderr: `Redirection error: ${redirectError instanceof Error ? redirectError.message : 'Unknown error'}`,
            exitCode: 1,
            newCwd: result.newCwd,
          };
        }
      }

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        newCwd: result.newCwd,
      };
    } catch (error) {
      return {
        stdout: '',
        stderr: `Error executing command '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`,
        exitCode: 1,
      };
    }
  }

  async execute(args: ShellToolParams): Promise<ToolResult> {
    const { command: commandStr } = args;

    if (!commandStr.trim()) {
      return { content: "Error: Empty command" };
    }

    // Parse compound commands
    const commands = this.parseCompoundCommand(commandStr);

    if (commands.length === 0) {
      return { content: "Error: No command specified" };
    }

    // If it's a simple command (no operators), use the optimized single command execution
    if (commands.length === 1) {
      const content = await this.executeSimpleCommand(commands[0].command);
      return { content };
    }

    // Execute compound commands
    const content = await this.executeCompoundCommands(commands);
    return { content };
  }

  /**
   * Execute a simple command (no compound operators)
   */
  private async executeSimpleCommand(commandStr: string): Promise<string> {
    const result = await this.executeSingleCommand(commandStr);

    // Update working directory if command changed it (e.g., cd)
    if (result.newCwd) {
      this.cwd = result.newCwd;
    }

    // Format output
    let output = '';

    if (result.stdout) {
      output += result.stdout;
    }

    if (result.stderr) {
      if (output) output += '\n';
      output += result.stderr;
    }

    // Add exit code info for non-zero exits
    if (result.exitCode !== 0) {
      if (output) output += '\n';
      output += `Exit code: ${result.exitCode}`;
    }

    return output || '(no output)';
  }

  /**
   * Handle output redirection to a file
   */
  private async handleRedirection(output: string, redirectType: '>' | '>>', redirectFile: string): Promise<void> {
    // Resolve the file path relative to current working directory
    const filePath = redirectFile.startsWith('/') ? redirectFile : `${this.cwd}/${redirectFile}`;

    if (redirectType === '>') {
      // Overwrite the file
      await this.fs.writeFile(filePath, output, 'utf8');
    } else if (redirectType === '>>') {
      // Append to the file
      try {
        const existingContent = await this.fs.readFile(filePath, 'utf8');
        await this.fs.writeFile(filePath, existingContent + output, 'utf8');
      } catch (error) {
        // If file doesn't exist, create it
        if (error instanceof Error && error.message.includes('ENOENT')) {
          await this.fs.writeFile(filePath, output, 'utf8');
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Execute compound commands with operators (&&, ||, ;, |)
   */
  private async executeCompoundCommands(commands: Array<{ command: string; operator?: string }>): Promise<string> {
    const outputs: string[] = [];
    let lastExitCode = 0;
    let pipeInput = '';

    for (let i = 0; i < commands.length; i++) {
      const { command: commandStr, operator } = commands[i];
      const prevOperator = i > 0 ? commands[i - 1].operator : undefined;

      // Handle conditional execution based on previous operator
      if (prevOperator === '&&' && lastExitCode !== 0) {
        // Previous command failed and we have &&, skip this command
        continue;
      }

      if (prevOperator === '||' && lastExitCode === 0) {
        // Previous command succeeded and we have ||, skip this command
        continue;
      }

      // Execute the command
      let result: { stdout: string; stderr: string; exitCode: number; newCwd?: string };

      if (prevOperator === '|') {
        // Handle pipe: pass previous output as input to current command
        result = await this.executeSingleCommand(commandStr, pipeInput);
      } else {
        result = await this.executeSingleCommand(commandStr);
      }

      // Update working directory if command changed it
      if (result.newCwd) {
        this.cwd = result.newCwd;
      }

      lastExitCode = result.exitCode;

      // Handle output based on current operator
      if (operator === '|') {
        // For pipe, store output for next command
        pipeInput = result.stdout;
      } else {
        // For other operators, add to outputs
        let output = '';

        if (result.stdout) {
          output += result.stdout;
        }

        if (result.stderr) {
          if (output) output += '\n';
          output += result.stderr;
        }

        // Add exit code info for non-zero exits (except for pipes)
        if (result.exitCode !== 0) {
          if (output) output += '\n';
          output += `Exit code: ${result.exitCode}`;
        }

        if (output) {
          outputs.push(output);
        }

        // Reset pipe input for non-pipe commands
        pipeInput = '';
      }
    }

    // Handle final pipe output
    if (pipeInput) {
      outputs.push(pipeInput);
    }

    return outputs.length > 0 ? outputs.join('\n') : '(no output)';
  }



  /**
   * Get the current working directory
   */
  getCurrentWorkingDirectory(): string {
    return this.cwd;
  }

  /**
   * Set the current working directory
   */
  setCurrentWorkingDirectory(newCwd: string): void {
    this.cwd = newCwd;
  }

  /**
   * Get list of available commands (excludes hidden easter eggs)
   */
  getAvailableCommands(): Array<{ name: string; description: string; usage: string }> {
    return Array.from(this.commands.values())
      .filter(cmd => !cmd.isEasterEgg) // Hide easter egg commands from help
      .map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        usage: cmd.usage,
      }));
  }
}