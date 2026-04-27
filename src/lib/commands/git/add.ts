import { join, isAbsolute, relative } from "path-browserify";
import type { JSRuntimeFS } from "../../JSRuntime";
import type { ShellCommandResult } from "../ShellCommand";
import { createSuccessResult, createErrorResult } from "../ShellCommand";
import type { GitSubcommand, GitSubcommandOptions } from "../git";
import type { Git } from "../../git";

export class GitAddCommand implements GitSubcommand {
  name = 'add';
  description = 'Add file contents to the index';
  usage = 'git add [--all | -A] [--update | -u] [--force | -f] [--dry-run | -n] [--] [<pathspec>...]';

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

      const { options, paths } = this.parseArgs(args);

      if (options.all) {
        // Add all files (git add -A)
        return await this.addAllFiles(cwd, options);
      } else if (options.update) {
        // Add only tracked files with changes (git add -u)
        return await this.updateTrackedFiles(paths, cwd, options);
      } else if (paths.length === 0) {
        return createErrorResult('Nothing specified, nothing added.\nMaybe you wanted to say \'git add .\'?');
      } else {
        // Add specific files
        return await this.addSpecificFiles(paths, cwd, options);
      }

    } catch (error) {
      return createErrorResult(`git add: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseArgs(args: string[]): {
    options: { all: boolean; update: boolean; force: boolean; dryRun: boolean };
    paths: string[];
  } {
    const options = { all: false, update: false, force: false, dryRun: false };
    const paths: string[] = [];
    let foundDoubleDash = false;

    for (const arg of args) {
      if (arg === '--') {
        foundDoubleDash = true;
        continue;
      }

      if (!foundDoubleDash && (arg === '--all' || arg === '-A')) {
        options.all = true;
      } else if (!foundDoubleDash && (arg === '--update' || arg === '-u')) {
        options.update = true;
      } else if (!foundDoubleDash && (arg === '--force' || arg === '-f')) {
        options.force = true;
      } else if (!foundDoubleDash && (arg === '--dry-run' || arg === '-n')) {
        options.dryRun = true;
      } else if (!foundDoubleDash && arg.startsWith('-')) {
        // Ignore other options for now
        continue;
      } else {
        paths.push(arg);
      }
    }

    return { options, paths };
  }

  /**
   * Normalize a path argument to a repo-relative path.
   * Returns null if the path is outside the repo.
   */
  private normalizePath(path: string, cwd: string): string | null {
    if (isAbsolute(path)) {
      // Convert absolute path to repo-relative
      if (!path.startsWith(cwd)) {
        return null; // Outside repo
      }
      const rel = relative(cwd, path);
      return rel || '.';
    }
    return path;
  }

  private async addAllFiles(cwd: string, options: { dryRun: boolean }): Promise<ShellCommandResult> {
    try {
      // Get status to find all changed files
      const statusMatrix = await this.git.statusMatrix({
        dir: cwd,
      });

      const added: string[] = [];

      for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
        try {
          if (workdirStatus === 0 && headStatus === 1) {
            // File was deleted in working directory
            if (!options.dryRun) {
              await this.git.remove({
                dir: cwd,
                filepath,
              });
            }
            added.push(`remove '${filepath}'`);
          } else if (workdirStatus === 2 && stageStatus !== 2) {
            // File exists and has changes that aren't staged yet
            if (!options.dryRun) {
              await this.git.add({
                dir: cwd,
                filepath,
              });
            }
            added.push(`add '${filepath}'`);
          }
        } catch {
          // Continue with other files if one fails
          console.warn(`Failed to add/remove ${filepath}`);
        }
      }

      if (options.dryRun) {
        return createSuccessResult(added.join('\n') + (added.length > 0 ? '\n' : ''));
      }

      // Git add is typically silent on success, like real git
      return createSuccessResult('');

    } catch (error) {
      return createErrorResult(`Failed to add all files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update only tracked files (git add -u behavior).
   * Skips untracked files.
   */
  private async updateTrackedFiles(
    paths: string[],
    cwd: string,
    options: { dryRun: boolean }
  ): Promise<ShellCommandResult> {
    try {
      const statusMatrix = await this.git.statusMatrix({ dir: cwd });
      const added: string[] = [];

      const matchesPath = (filepath: string): boolean => {
        if (paths.length === 0) return true;
        return paths.some(p => {
          const normalized = this.normalizePath(p, cwd);
          if (!normalized || normalized === '.') return true;
          return filepath === normalized || filepath.startsWith(normalized + '/');
        });
      };

      for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
        // Only process tracked files (headStatus === 1)
        if (headStatus !== 1) continue;
        if (!matchesPath(filepath)) continue;

        try {
          if (workdirStatus === 0) {
            // File was deleted
            if (!options.dryRun) {
              await this.git.remove({ dir: cwd, filepath });
            }
            added.push(`remove '${filepath}'`);
          } else if (workdirStatus === 2 && stageStatus !== 2) {
            // File modified
            if (!options.dryRun) {
              await this.git.add({ dir: cwd, filepath });
            }
            added.push(`add '${filepath}'`);
          }
        } catch {
          // Continue on error
        }
      }

      if (options.dryRun) {
        return createSuccessResult(added.join('\n') + (added.length > 0 ? '\n' : ''));
      }
      return createSuccessResult('');
    } catch (error) {
      return createErrorResult(`Failed to update tracked files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async addSpecificFiles(
    paths: string[],
    cwd: string,
    options: { force: boolean; dryRun: boolean }
  ): Promise<ShellCommandResult> {
    const addedFiles: string[] = [];
    const errors: string[] = [];

    for (const path of paths) {
      try {
        if (path === '.') {
          // Add current directory (all files in it)
          const statusMatrix = await this.git.statusMatrix({
            dir: cwd,
          });

          for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix) {
            try {
              if (workdirStatus === 0 && headStatus === 1) {
                // File was deleted in working directory
                if (!options.dryRun) {
                  await this.git.remove({
                    dir: cwd,
                    filepath,
                  });
                }
                addedFiles.push(filepath);
              } else if (workdirStatus === 2 && stageStatus !== 2) {
                // File exists and has changes that aren't staged yet
                if (!options.dryRun) {
                  await this.git.add({
                    dir: cwd,
                    filepath,
                  });
                }
                addedFiles.push(filepath);
              }
            } catch {
              // Continue with other files
            }
          }
        } else {
          // Normalize path (handle absolute paths)
          const normalized = this.normalizePath(path, cwd);
          if (normalized === null) {
            errors.push(`fatal: ${path}: '${path}' is outside repository`);
            continue;
          }

          const absolutePath = join(cwd, normalized);

          // Check if file/directory exists
          try {
            const stats = await this.fs.stat(absolutePath);

            if (stats.isDirectory()) {
              // Add all files in directory
              await this.addDirectory(normalized, addedFiles, cwd, options);
            } else {
              // Add single file
              if (!options.dryRun) {
                await this.git.add({
                  dir: cwd,
                  filepath: normalized,
                });
              }
              addedFiles.push(normalized);
            }
          } catch {
            // Check if it's a deleted file
            try {
              if (!options.dryRun) {
                await this.git.remove({
                  dir: cwd,
                  filepath: normalized,
                });
              }
              addedFiles.push(normalized);
            } catch {
              errors.push(`fatal: pathspec '${path}' did not match any files`);
            }
          }
        }
      } catch (error) {
        errors.push(`'${path}': ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (errors.length > 0) {
      return createErrorResult(errors.join('\n'));
    }

    if (options.dryRun) {
      return createSuccessResult(addedFiles.map(f => `add '${f}'`).join('\n') + (addedFiles.length > 0 ? '\n' : ''));
    }

    // Git add is typically silent on success, like real git
    return createSuccessResult('');
  }

  private async addDirectory(
    dirPath: string,
    addedFiles: string[],
    cwd: string,
    options: { force: boolean; dryRun: boolean }
  ): Promise<void> {
    const absolutePath = join(cwd, dirPath);
    const entries = await this.fs.readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip only the .git directory. Real git tracks other dotfiles like .gitignore.
      if (entry.name === '.git') {
        continue;
      }

      const entryPath = dirPath === '.' ? entry.name : join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await this.addDirectory(entryPath, addedFiles, cwd, options);
      } else {
        // Check gitignore unless --force is specified
        if (!options.force) {
          try {
            const ignored = await this.git.isIgnored({
              dir: cwd,
              filepath: entryPath,
            });
            if (ignored) continue;
          } catch {
            // If isIgnored fails, proceed with adding
          }
        }

        try {
          if (!options.dryRun) {
            await this.git.add({
              dir: cwd,
              filepath: entryPath,
            });
          }
          addedFiles.push(entryPath);
        } catch {
          // Continue with other files
        }
      }
    }
  }
}
