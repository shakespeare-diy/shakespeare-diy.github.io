import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

interface TagOptions {
  annotated: boolean;
  force: boolean;
  list: boolean;
  showMessages: boolean;
  message?: string;
}

type TagAction = 'list' | 'create' | 'delete';

export class GitTagCommand implements GitSubcommand {
  name = 'tag';
  description = 'Create, list, delete or verify a tag object';
  usage = 'git tag [-l [<pattern>]] [-n [<num>]] | git tag [-a] [-f] [-m <msg>] <tagname> [<commit>] | git tag -d <tagname>...';

  private git: Git;
  private fs: JSRuntimeFS;

  constructor(options: GitSubcommandOptions) {
    this.git = options.git;
    this.fs = options.fs;
  }

  async execute(args: string[], cwd: string): Promise<ShellCommandResult> {
    try {
      // Check if we're in a git repository
      try {
        await this.fs.stat(`${cwd}/.git`);
      } catch {
        return createErrorResult('fatal: not a git repository (or any of the parent directories): .git');
      }

      const { action, tagName, commit, options, pattern } = this.parseArgs(args);

      switch (action) {
        case 'list':
          return await this.listTags(pattern, options.showMessages, cwd);
        case 'create':
          return await this.createTag(tagName!, cwd, commit, options);
        case 'delete':
          return await this.deleteTag(tagName!, cwd);
        default:
          return await this.listTags(pattern, options.showMessages, cwd);
      }

    } catch (error) {
      return createErrorResult(`git tag: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    action: TagAction;
    tagName?: string;
    commit?: string;
    pattern?: string;
    options: TagOptions;
  } {
    const options: TagOptions = {
      annotated: false,
      force: false,
      list: false,
      showMessages: false,
    };
    let action: TagAction = 'list';
    let tagName: string | undefined;
    let commit: string | undefined;
    let pattern: string | undefined;
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '-l' || arg === '--list') {
        action = 'list';
        options.list = true;
      } else if (arg === '-d' || arg === '--delete') {
        action = 'delete';
      } else if (arg === '-a' || arg === '--annotate') {
        options.annotated = true;
      } else if (arg === '-f' || arg === '--force') {
        options.force = true;
      } else if (arg === '-n' || arg.match(/^-n\d+$/)) {
        options.showMessages = true;
        action = 'list';
      } else if (arg === '-m' || arg === '--message') {
        if (i + 1 < args.length) {
          options.message = args[i + 1];
          options.annotated = true;
          i++;
        }
      } else if (arg.startsWith('-m=')) {
        options.message = arg.substring(3);
        options.annotated = true;
      } else if (arg.startsWith('--message=')) {
        options.message = arg.substring(10);
        options.annotated = true;
      } else if (!arg.startsWith('-')) {
        positionals.push(arg);
      }
    }

    if (action === 'delete') {
      tagName = positionals[0];
    } else if (action === 'list') {
      pattern = positionals[0];
    } else if (positionals.length >= 1) {
      action = 'create';
      tagName = positionals[0];
      if (positionals.length >= 2) {
        commit = positionals[1];
      }
    }

    return { action, tagName, commit, pattern, options };
  }

  private matchPattern(tagName: string, pattern?: string): boolean {
    if (!pattern) return true;
    // Simple glob: convert * to .* and ? to .
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return regex.test(tagName);
  }

  private async listTags(pattern: string | undefined, showMessages: boolean, cwd: string): Promise<ShellCommandResult> {
    try {
      const tags = await this.git.listTags({ dir: cwd });

      const filtered = tags.filter(t => this.matchPattern(t, pattern));
      if (filtered.length === 0) {
        return createSuccessResult('');
      }

      filtered.sort();

      if (showMessages) {
        const lines: string[] = [];
        for (const tag of filtered) {
          try {
            // Try to read as annotated tag
            const oid = await this.git.resolveRef({ dir: cwd, ref: tag });
            try {
              const tagObj = await this.git.readTag({ dir: cwd, oid });
              const firstLine = (tagObj.tag.message || '').split('\n')[0];
              lines.push(`${tag.padEnd(15)} ${firstLine}`);
            } catch {
              // Lightweight tag: show commit message
              try {
                const log = await this.git.log({ dir: cwd, depth: 1, ref: tag });
                if (log.length > 0) {
                  lines.push(`${tag.padEnd(15)} ${log[0].commit.message.split('\n')[0]}`);
                } else {
                  lines.push(tag);
                }
              } catch {
                lines.push(tag);
              }
            }
          } catch {
            lines.push(tag);
          }
        }
        return createSuccessResult(lines.join('\n') + '\n');
      }

      return createSuccessResult(filtered.join('\n') + '\n');

    } catch (error) {
      return createErrorResult(`Failed to list tags: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createTag(
    tagName: string,
    cwd: string,
    commit: string | undefined,
    options: TagOptions,
  ): Promise<ShellCommandResult> {
    try {
      if (!tagName) {
        return createErrorResult('usage: git tag <tagname> [<commit>]');
      }

      // Check if tag already exists (unless --force)
      if (!options.force) {
        try {
          const tags = await this.git.listTags({ dir: cwd });
          if (tags.includes(tagName)) {
            return createErrorResult(`fatal: tag '${tagName}' already exists`);
          }
        } catch {
          // Continue
        }
      } else {
        // Delete existing tag first if --force
        try {
          const tags = await this.git.listTags({ dir: cwd });
          if (tags.includes(tagName)) {
            await this.git.deleteTag({ dir: cwd, ref: tagName });
          }
        } catch {
          // Continue
        }
      }

      // Resolve the target commit
      let targetOid: string;
      try {
        targetOid = await this.git.resolveRef({
          dir: cwd,
          ref: commit || 'HEAD',
        });
      } catch {
        return createErrorResult(`fatal: not a valid object name: '${commit || 'HEAD'}'`);
      }

      // Create annotated or lightweight tag
      if (options.annotated || options.message) {
        const message = options.message || tagName;
        try {
          await this.git.annotatedTag({
            dir: cwd,
            ref: tagName,
            object: targetOid,
            message,
          });
        } catch (error) {
          // Fallback to lightweight tag
          await this.git.tag({
            dir: cwd,
            ref: tagName,
            object: targetOid,
          });
          console.warn(`Created lightweight tag instead of annotated: ${error instanceof Error ? error.message : error}`);
        }
      } else {
        await this.git.tag({
          dir: cwd,
          ref: tagName,
          object: targetOid,
        });
      }

      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to create tag: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async deleteTag(tagName: string, cwd: string): Promise<ShellCommandResult> {
    try {
      if (!tagName) {
        return createErrorResult('usage: git tag -d <tagname>');
      }

      // Check if tag exists
      try {
        const tags = await this.git.listTags({ dir: cwd });

        if (!tags.includes(tagName)) {
          return createErrorResult(`error: tag '${tagName}' not found.`);
        }
      } catch {
        return createErrorResult(`error: tag '${tagName}' not found.`);
      }

      // Delete the tag
      await this.git.deleteTag({
        dir: cwd,
        ref: tagName,
      });

      return createSuccessResult(`Deleted tag '${tagName}'\n`);

    } catch (error) {
      return createErrorResult(`Failed to delete tag: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
