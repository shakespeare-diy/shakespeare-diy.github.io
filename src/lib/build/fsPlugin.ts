import { join, dirname, extname } from "path-browserify";

import type { Loader, Plugin } from "esbuild-wasm";
import type { JSRuntimeFS } from '@/lib/JSRuntime';

import { detectWorkersAndAssets, type WorkerMatch, type AssetMatch } from "./workerPlugin";

interface TsConfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

interface PackageJson {
  dependencies?: { [key: string]: string };
  devDependencies?: { [key: string]: string };
  peerDependencies?: { [key: string]: string };
}

interface FsPluginOptions {
  fs: JSRuntimeFS;
  cwd: string;
  tsconfig?: TsConfig;
  packageJson?: PackageJson;
  /**
   * Optional collectors populated when a source file contains
   * `new Worker(new URL(...))` / `new SharedWorker(new URL(...))` /
   * `new URL(..., import.meta.url)` patterns.
   */
  collectWorkers?: WorkerMatch[];
  collectAssets?: AssetMatch[];
}

export function fsPlugin(options: FsPluginOptions): Plugin {
  const { fs, cwd, tsconfig, packageJson, collectWorkers, collectAssets } = options;
  return {
    name: "fs",

    setup(build) {
      build.onResolve({ filter: /^data:/ }, (args) => {
        return {
          path: args.path,
          external: true,
        };
      });

      build.onResolve({ filter: /.*/ }, async (args) => {
        // Skip resolving paths from external URLs (but not fs: namespace)
        if (/^https?:\/\//.test(args.importer)) {
          return;
        }

        const resolved = await resolveFromImporter(args.path, args.importer, {
          fs,
          cwd,
          tsconfig,
          packageJson,
        });

        if (!resolved) return;

        return {
          path: resolved,
          namespace: "fs",
        };
      });

      build.onLoad(
        { filter: /.*/, namespace: "fs" },
        async (args) => {
          const [path, query] = args.path.split("?");
          const params = new URLSearchParams(query);

          // https://vite.dev/guide/assets.html#importing-asset-as-string
          if (params.has("raw")) {
            return {
              contents: await fs.readFile(path, "utf8"),
              loader: "text",
            };
          }

          const ext = extname(path).slice(1);

          // Handle static assets
          if (!["ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "json"].includes(ext)) {
            return {
              contents: await fs.readFile(path),
              loader: "file",
            };
          }

          let contents = await fs.readFile(path, "utf8");

          // Run worker/asset detection on source-code files. This only
          // does any real work if the file contains `new URL(`; the
          // prefilter inside `detectWorkersAndAssets` bails early
          // otherwise.
          if (
            (collectWorkers || collectAssets) &&
            ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)
          ) {
            const result = await detectWorkersAndAssets({
              source: contents,
              filePath: path,
              ext,
              resolveSpec: async (spec, importerPath) => {
                const resolved = await resolveFromImporter(spec, importerPath, {
                  fs,
                  cwd,
                  tsconfig,
                  packageJson,
                });
                if (!resolved) return undefined;
                // Strip any ?query that made it onto the resolved path.
                return resolved.split("?")[0];
              },
            });
            if (result.workers.length || result.assets.length) {
              contents = result.code;
              if (collectWorkers) collectWorkers.push(...result.workers);
              if (collectAssets) collectAssets.push(...result.assets);
            }
          }

          return {
            contents,
            loader: ext as Loader,
          };
        },
      );
    },
  };
}

interface ResolveContext {
  fs: JSRuntimeFS;
  cwd: string;
  tsconfig?: TsConfig;
  packageJson?: PackageJson;
}

/**
 * Resolve a module specifier against an importer. This mirrors the
 * resolution rules used by the fs plugin's onResolve handler so it
 * can be reused by the worker/asset detection pass.
 */
export async function resolveFromImporter(
  path: string,
  importer: string | undefined,
  ctx: ResolveContext,
): Promise<string | undefined> {
  const { fs, cwd, tsconfig, packageJson } = ctx;

  let resolved: string | undefined;

  // Handle absolute paths
  if (path.startsWith("/")) {
    resolved = path;
  }
  // Handle @/ alias
  else if (path.startsWith("@/")) {
    resolved = join(cwd, "src", path.slice(2));
  }
  // Handle relative paths
  else if (importer && (path.startsWith("./") || path.startsWith("../"))) {
    const importerPath = importer.replace(/^fs:/, '');
    resolved = join(dirname(importerPath), path);
  }
  // Handle bare imports (e.g., "react", "@scope/package")
  else if (path.match(/^[^./]/)) {
    const packageName = path.startsWith("@")
      ? path.split("/").slice(0, 2).join("/")
      : path.split("/")[0];

    const allDeps = {
      ...packageJson?.dependencies,
      ...packageJson?.devDependencies,
      ...packageJson?.peerDependencies,
    };

    const depVersion = allDeps[packageName];

    if (depVersion && depVersion.startsWith("file:")) {
      const filePath = depVersion.slice(5);
      const packagePath = join(cwd, filePath);
      const subpath = path.slice(packageName.length);
      resolved = join(packagePath, subpath);
    } else {
      return undefined;
    }
  }
  // Handle tsconfig baseUrl
  else if (importer && tsconfig?.compilerOptions?.baseUrl) {
    resolved = join(cwd, tsconfig.compilerOptions.baseUrl, path);
  }
  else {
    return undefined;
  }

  if (!resolved) return undefined;

  // Vite query parameters https://vite.dev/guide/assets
  const [cleaned, query] = resolved.split("?");

  try {
    resolved = await tryFileVariants(fs, cleaned);
  } catch {
    return undefined;
  }

  return resolved + (typeof query === "string" ? "?" + query : "");
}

async function tryFileVariants(
  fs: JSRuntimeFS,
  basePath: string,
): Promise<string> {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".css"];
  const stat = await statSafe(fs, basePath);

  // If it's a file, check if it exists
  if (stat.isFile()) {
    return basePath;
  }

  // If it's a directory, try package.json first, then index files
  if (stat.isDirectory()) {
    // Try to read package.json for entry point
    try {
      const packageJsonPath = join(basePath, "package.json");
      const packageJsonText = await fs.readFile(packageJsonPath, "utf8");
      const packageJson = JSON.parse(packageJsonText);

      // Check for various entry point fields
      const entryPoint = packageJson.exports?.['.']
        || packageJson.module
        || packageJson.main
        || 'index.js';

      // Resolve the entry point
      const entryPath = typeof entryPoint === 'string'
        ? join(basePath, entryPoint)
        : join(basePath, 'index.js');

      const entryStat = await statSafe(fs, entryPath);
      if (entryStat.isFile()) {
        return entryPath;
      }

      // Try with different extensions if the entry point doesn't exist
      for (const ext of extensions) {
        const entryWithExt = entryPath.replace(/\.[^.]+$/, '') + ext;
        const entryExtStat = await statSafe(fs, entryWithExt);
        if (entryExtStat.isFile()) {
          return entryWithExt;
        }
      }
    } catch {
      // package.json doesn't exist or is invalid, fall through to index files
    }

    // Fall back to trying index files
    for (const ext of extensions) {
      const indexFile = join(basePath, "index" + ext);
      const indexStat = await statSafe(fs, indexFile);
      if (indexStat.isFile()) {
        return indexFile;
      }
    }
  }

  // Try direct file with extensions
  for (const ext of extensions) {
    const full = basePath + ext;
    const fullStat = await statSafe(fs, full);
    if (fullStat.isFile()) {
      return full;
    }
  }

  // If no file found, throw an error
  throw new Error("File not found");
}

async function statSafe(fs: JSRuntimeFS, filePath: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
  try {
    return await fs.stat(filePath);
  } catch {
    return {
      isFile: () => false,
      isDirectory: () => false,
    };
  }
}
