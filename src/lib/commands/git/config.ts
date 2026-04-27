import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

type ConfigAction = 'list' | 'get' | 'set' | 'unset' | 'get-all' | 'add';

export class GitConfigCommand implements GitSubcommand {
  name = 'config';
  description = 'Get and set repository or global options';
  usage = 'git config [--global | --local] [--list] [--get | --get-all | --unset | --add] <name> [<value>]';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      const { action, key, value, options } = this.parseArgs(args);

      // Check if we're in a git repository (unless --global is used)
      if (!options.global) {
        try {
          await this.fs.stat(`${cwd}/.git`);
        } catch {
          return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
        }
      }

      switch (action) {
        case 'list':
          return await this.listConfig(options.global, cwd);
        case 'get':
          return await this.getConfig(key!, options.global, cwd);
        case 'get-all':
          return await this.getConfigAll(key!, options.global, cwd);
        case 'set':
          return await this.setConfig(key!, value!, options.global, cwd);
        case 'add':
          return await this.addConfig(key!, value!, options.global, cwd);
        case 'unset':
          return await this.unsetConfig(key!, options.global, cwd);
        default:
          return createErrorResult('usage: git config [--global | --local] [--list] [--get | --get-all | --unset | --add] <name> [<value>]');
      }

    } catch (error) {
      return createErrorResult(`git config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    action: ConfigAction;
    key?: string;
    value?: string;
    options: { global: boolean; local: boolean };
  } {
    const options = { global: false, local: false };
    let action: ConfigAction = 'get';
    let key: string | undefined;
    let value: string | undefined;
    let explicitAction = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--global') {
        options.global = true;
      } else if (arg === '--local') {
        options.local = true;
      } else if (arg === '--system') {
        // Not supported; treat as global
        options.global = true;
      } else if (arg === '--list' || arg === '-l') {
        action = 'list';
        explicitAction = true;
      } else if (arg === '--get') {
        action = 'get';
        explicitAction = true;
        if (i + 1 < args.length) {
          key = args[i + 1];
          i++;
        }
      } else if (arg === '--get-all') {
        action = 'get-all';
        explicitAction = true;
        if (i + 1 < args.length) {
          key = args[i + 1];
          i++;
        }
      } else if (arg === '--add') {
        action = 'add';
        explicitAction = true;
        if (i + 1 < args.length) {
          key = args[i + 1];
          i++;
        }
        if (i + 1 < args.length) {
          value = args[i + 1];
          i++;
        }
      } else if (arg === '--unset') {
        action = 'unset';
        explicitAction = true;
        if (i + 1 < args.length) {
          key = args[i + 1];
          i++;
        }
      } else if (!arg.startsWith('-')) {
        if (!key) {
          key = arg;
          if (!explicitAction) action = 'get';
        } else if (!value) {
          value = arg;
          if (!explicitAction) action = 'set';
        }
      }
    }

    return { action, key, value, options };
  }

  /**
   * Read the .git/config file directly to list all keys.
   */
  private async readConfigFile(global: boolean, cwd: string): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const configPath = global ? '/config/git.json' : `${cwd}/.git/config`;
    try {
      const content = await this.fs.readFile(configPath, 'utf8');

      if (global) {
        // JSON-based global config
        try {
          const parsed = JSON.parse(content);
          const flatten = (obj: Record<string, unknown>, prefix: string = ''): void => {
            for (const [k, v] of Object.entries(obj)) {
              const fullKey = prefix ? `${prefix}.${k}` : k;
              if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                flatten(v as Record<string, unknown>, fullKey);
              } else if (Array.isArray(v)) {
                result.set(fullKey, v.map(String));
              } else {
                result.set(fullKey, [String(v)]);
              }
            }
          };
          flatten(parsed);
        } catch {
          // Not JSON
        }
      } else {
        // INI-format .git/config
        let section = '';
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#') || line.startsWith(';')) continue;
          const sectionMatch = line.match(/^\[([^\]]+)\]$/);
          if (sectionMatch) {
            section = sectionMatch[1].trim().replace(/\s+"/, '.').replace(/"$/, '').replace(/\s+/g, '.');
            continue;
          }
          const kvMatch = line.match(/^([^=]+?)\s*=\s*(.*)$/);
          if (kvMatch && section) {
            const fullKey = `${section}.${kvMatch[1].trim()}`.toLowerCase();
            const val = kvMatch[2].replace(/^["']|["']$/g, '');
            const existing = result.get(fullKey) || [];
            existing.push(val);
            result.set(fullKey, existing);
          }
        }
      }
    } catch {
      // Config file doesn't exist or couldn't be read
    }
    return result;
  }

  private async listConfig(global: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      const configMap = await this.readConfigFile(global, cwd);
      const lines: string[] = [];
      for (const [key, values] of configMap) {
        for (const value of values) {
          lines.push(`${key}=${value}`);
        }
      }

      // Also include common keys that might only be accessible via getConfig
      const commonKeys = ['user.name', 'user.email', 'core.bare', 'remote.origin.url', 'remote.origin.fetch'];
      for (const key of commonKeys) {
        if (!configMap.has(key.toLowerCase())) {
          try {
            const val = await this.git.getConfig({
              dir: global ? undefined : cwd,
              path: key,
            });
            if (val !== undefined && val !== null) {
              lines.push(`${key}=${val}`);
            }
          } catch {
            // Skip
          }
        }
      }

      return createSuccessResult(lines.join('\n') + (lines.length > 0 ? '\n' : ''));

    } catch (error) {
      return createErrorResult(`Failed to list config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getConfig(key: string, global: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      const value = await this.git.getConfig({
        dir: global ? undefined : cwd,
        path: key,
      });

      if (value === undefined || value === null) {
        return createErrorResult(`error: key does not exist: ${key}`);
      }

      return createSuccessResult(value + '\n');

    } catch (error) {
      return createErrorResult(`Failed to get config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async getConfigAll(key: string, global: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      const values = await this.git.getConfigAll({
        dir: global ? undefined : cwd,
        path: key,
      });

      if (!values || values.length === 0) {
        return createErrorResult(`error: key does not exist: ${key}`);
      }

      return createSuccessResult(values.join('\n') + '\n');

    } catch (error) {
      return createErrorResult(`Failed to get config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async setConfig(key: string, value: string, global: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      await this.git.setConfig({
        dir: global ? undefined : cwd,
        path: key,
        value: value,
      });

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to set config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async addConfig(key: string, value: string, global: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      await this.git.setConfig({
        dir: global ? undefined : cwd,
        path: key,
        value: value,
        append: true,
      } as Parameters<typeof this.git.setConfig>[0]);

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to add config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async unsetConfig(key: string, global: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      await this.git.setConfig({
        dir: global ? undefined : cwd,
        path: key,
        value: undefined,
      } as Parameters<typeof this.git.setConfig>[0]);

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to unset config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
