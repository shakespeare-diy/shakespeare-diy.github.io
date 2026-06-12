import git from 'isomorphic-git';
import { Loader2, Zap } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useFS } from '@/hooks/useFS';
import { useFSPaths } from '@/hooks/useFSPaths';
import { toast } from '@/hooks/useToast';
import type { JSRuntimeFS } from '@/lib/JSRuntime';

/**
 * "Optimize Repository" entry for the project dropdown.
 *
 * Fully self-contained recovery action: clicking it consolidates the
 * project's git pack files into a single pack containing every reachable
 * object, deletes the old packs and redundant loose objects, and reports
 * the size reduction in a toast. A spinner toast is shown while it runs.
 *
 * Everything (UI, gc algorithm, state) lives in this one file so the
 * feature can be removed by deleting this file and its single render
 * line in ProjectTitleMenu.
 */

/** Projects with an optimization currently in flight (reentrancy guard). */
const running = new Set<string>();

// ---------------------------------------------------------------------------
// Repository optimization (simplified `git gc` for isomorphic-git repos)
// ---------------------------------------------------------------------------

/** Yield to the event loop so the UI can paint between batches of work. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Recursively sum the size of all files under `path`. */
async function dirSize(fs: JSRuntimeFS, path: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(path);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const child = `${path}/${name}`;
    try {
      const stat = await fs.stat(child);
      if (stat.isDirectory()) {
        total += await dirSize(fs, child);
      } else {
        total += stat.size ?? 0;
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return total;
}

/**
 * Recursively walk a tree, adding every blob/tree OID to `reachable`.
 * Returns the number of objects that could not be read.
 */
async function walkTree(
  fs: JSRuntimeFS,
  gitdir: string,
  treeOid: string,
  reachable: Set<string>,
  visitedTrees: Set<string>,
): Promise<number> {
  if (visitedTrees.has(treeOid)) return 0;
  visitedTrees.add(treeOid);

  let tree: Awaited<ReturnType<typeof git.readTree>>;
  try {
    tree = await git.readTree({ fs, gitdir, oid: treeOid });
  } catch {
    return 1;
  }
  reachable.add(treeOid);

  let errors = 0;
  for (const entry of tree.tree) {
    if (entry.type === 'tree') {
      errors += await walkTree(fs, gitdir, entry.oid, reachable, visitedTrees);
    } else if (entry.type === 'blob') {
      reachable.add(entry.oid);
    }
    // entry.type === 'commit' is a submodule gitlink; skip.
  }
  return errors;
}

interface OptimizeResult {
  bytesBefore: number;
  bytesAfter: number;
  /** True when some objects could not be read, so the repo was left untouched. */
  incomplete: boolean;
}

/**
 * Consolidate all reachable objects into one new pack, then delete the old
 * packs and redundant loose objects.
 *
 * Non-destructive: every object reachable from any ref or HEAD is preserved.
 * If any object fails to read during the reachability walk, or the new pack
 * would be larger than the files it replaces, the repository is left
 * completely untouched.
 */
async function optimizeRepository(fs: JSRuntimeFS, dir: string): Promise<OptimizeResult> {
  const gitdir = `${dir}/.git`;
  const objectsDir = `${gitdir}/objects`;
  const packDir = `${objectsDir}/pack`;

  const bytesBefore = await dirSize(fs, objectsDir);

  let oldPackEntries: string[];
  try {
    oldPackEntries = await fs.readdir(packDir);
  } catch {
    oldPackEntries = [];
  }

  // 1. Collect ref tips (branches, tags, remotes, stash, HEAD).
  const tips = new Set<string>();
  let refs: string[] = [];
  try {
    refs = await git.listRefs({ fs, gitdir, filepath: 'refs' });
  } catch {
    refs = [];
  }
  for (const ref of refs) {
    try {
      tips.add(await git.resolveRef({ fs, gitdir, ref: `refs/${ref}` }));
    } catch {
      // Broken ref; skip.
    }
  }
  try {
    tips.add(await git.resolveRef({ fs, gitdir, ref: 'HEAD' }));
  } catch {
    // No HEAD (fresh repo).
  }

  // 2. Walk reachability from every tip.
  const reachable = new Set<string>();
  const visitedTrees = new Set<string>();
  const stack = [...tips];
  let walkErrors = 0;
  let steps = 0;

  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (reachable.has(oid)) continue;

    let parsed: Awaited<ReturnType<typeof git.readObject>>;
    try {
      parsed = await git.readObject({ fs, gitdir, oid, format: 'parsed' });
    } catch {
      walkErrors++;
      continue;
    }

    reachable.add(oid);

    if (parsed.type === 'commit') {
      const commit = parsed.object as { tree: string; parent: string[] };
      for (const parent of commit.parent) stack.push(parent);
      walkErrors += await walkTree(fs, gitdir, commit.tree, reachable, visitedTrees);
    } else if (parsed.type === 'tag') {
      stack.push((parsed.object as { object: string }).object);
    } else if (parsed.type === 'tree') {
      walkErrors += await walkTree(fs, gitdir, oid, reachable, visitedTrees);
    }

    if (++steps % 64 === 0) await yieldToMain();
  }

  if (walkErrors > 0 || reachable.size === 0) {
    // Damaged repo (or empty repo) — change nothing.
    return { bytesBefore, bytesAfter: bytesBefore, incomplete: walkErrors > 0 };
  }

  // 3. Write the consolidated pack and its index.
  await yieldToMain();
  const { filename } = await git.packObjects({
    fs,
    gitdir,
    oids: [...reachable],
    write: true,
  });
  await git.indexPack({ fs, dir, gitdir, filepath: `.git/objects/pack/${filename}` });

  // 4. Safety check: isomorphic-git writes undeltified packs, which can be
  // larger than the (server-deltified) packs they replace. Only proceed if
  // deleting the old packs and loose copies reclaims more than the new pack
  // costs; otherwise remove the new pack and leave the repo exactly as-is.
  const fileSize = async (path: string): Promise<number> => {
    try {
      return (await fs.stat(path)).size ?? 0;
    } catch {
      return 0;
    }
  };
  const newBase = filename!.replace(/\.pack$/, '');
  const newPackBytes =
    (await fileSize(`${packDir}/${filename}`)) + (await fileSize(`${packDir}/${newBase}.idx`));
  let reclaimableBytes = 0;
  for (const name of oldPackEntries) {
    if (name.startsWith(`${newBase}.`)) continue;
    if (!/\.(pack|idx)$/.test(name)) continue;
    reclaimableBytes += await fileSize(`${packDir}/${name}`);
  }
  steps = 0;
  for (const oid of reachable) {
    reclaimableBytes += await fileSize(`${objectsDir}/${oid.slice(0, 2)}/${oid.slice(2)}`);
    if (++steps % 64 === 0) await yieldToMain();
  }
  if (newPackBytes >= reclaimableBytes) {
    for (const name of [filename!, `${newBase}.idx`]) {
      try {
        await fs.unlink(`${packDir}/${name}`);
      } catch {
        // Best-effort.
      }
    }
    return { bytesBefore, bytesAfter: bytesBefore, incomplete: false };
  }

  // 5. Delete the old pack files.
  for (const name of oldPackEntries) {
    if (name.startsWith(`${newBase}.`)) continue;
    if (!/\.(pack|idx)$/.test(name)) continue;
    try {
      await fs.unlink(`${packDir}/${name}`);
    } catch {
      // Best-effort.
    }
  }

  // 6. Delete loose copies of objects now stored in the new pack.
  const touchedDirs = new Set<string>();
  steps = 0;
  for (const oid of reachable) {
    const looseDir = `${objectsDir}/${oid.slice(0, 2)}`;
    try {
      await fs.unlink(`${looseDir}/${oid.slice(2)}`);
      touchedDirs.add(looseDir);
    } catch {
      // Object wasn't loose; nothing to do.
    }
    if (++steps % 64 === 0) await yieldToMain();
  }

  // Remove now-empty loose object shards.
  for (const looseDir of touchedDirs) {
    try {
      if ((await fs.readdir(looseDir)).length === 0) await fs.rmdir(looseDir);
    } catch {
      // Best-effort.
    }
  }

  const bytesAfter = await dirSize(fs, objectsDir);
  return { bytesBefore, bytesAfter, incomplete: false };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

async function run(fs: JSRuntimeFS, dir: string, projectId: string) {
  if (running.has(projectId)) return;
  running.add(projectId);

  const progress = toast({
    description: (
      <span className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Optimizing repository…
      </span>
    ),
    duration: Infinity,
  });

  try {
    const result = await optimizeRepository(fs, dir);
    const saved = result.bytesBefore - result.bytesAfter;

    progress.update({
      id: progress.id,
      title: 'Repository optimized',
      description: result.incomplete
        ? 'Some objects could not be read, so the repository was left untouched for safety.'
        : saved > 0
          ? `${formatBytes(result.bytesBefore)} → ${formatBytes(result.bytesAfter)} (saved ${formatBytes(saved)})`
          : `No size reduction (${formatBytes(result.bytesAfter)})`,
      duration: 10000,
    });
  } catch (error) {
    progress.update({
      id: progress.id,
      title: 'Repository optimization failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
      duration: 10000,
    });
  } finally {
    running.delete(projectId);
  }
}

interface OptimizeRepositoryMenuItemProps {
  projectId: string;
  disabled?: boolean;
}

export function OptimizeRepositoryMenuItem({ projectId, disabled }: OptimizeRepositoryMenuItemProps) {
  const { fs } = useFS();
  const { projectsPath } = useFSPaths();

  return (
    <DropdownMenuItem
      onClick={() => run(fs, `${projectsPath}/${projectId}`, projectId)}
      disabled={disabled}
      className="gap-2"
    >
      <Zap className="h-4 w-4" />
      Optimize Repository
    </DropdownMenuItem>
  );
}
