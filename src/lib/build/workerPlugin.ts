// Detection and rewriting for the Vite/webpack-compatible worker and
// asset URL patterns:
//
//   new Worker(new URL("<spec>", import.meta.url), { type: "module" })
//   new SharedWorker(new URL("<spec>", import.meta.url), { type: "module" })
//   new URL("<spec>", import.meta.url)   // for non-source assets
//
// esbuild-wasm exposes no onTransform/onParse hook, so we can't reuse
// esbuild's internal AST. To avoid parsing every source file a second
// time, we prefilter with a cheap regex and only invoke acorn on files
// that contain a relevant construct. TS/JSX files are stripped via
// esbuild.transform before being handed to acorn so we don't need a
// TypeScript-aware parser.

import * as acorn from "acorn";
import jsx from "acorn-jsx";
import { getEsbuild } from "@/lib/esbuild";

const ParserWithJsx = acorn.Parser.extend(jsx());

// Cheap prefilter: bail out for the 99% of files that contain no
// `new URL(` call at all.
const PREFILTER = /\bnew\s+URL\s*\(/;

export interface WorkerMatch {
  /** Unique placeholder token written into the source in place of the spec string. */
  placeholder: string;
  /** Resolved absolute path of the worker entry in the VFS. */
  resolvedPath: string;
  /** "Worker" or "SharedWorker". */
  kind: "Worker" | "SharedWorker";
}

export interface AssetMatch {
  /** Unique placeholder token written into the source in place of the spec string. */
  placeholder: string;
  /** Resolved absolute path of the asset in the VFS. */
  resolvedPath: string;
}

export interface DetectResult {
  /** The (possibly) rewritten source text. */
  code: string;
  workers: WorkerMatch[];
  assets: AssetMatch[];
}

export interface DetectOptions {
  /** The original source text as stored in the VFS. */
  source: string;
  /** The path of the file being processed, for diagnostics. */
  filePath: string;
  /** Extension of the source ("ts", "tsx", "js", "jsx", "mjs", "cjs"). */
  ext: string;
  /**
   * Resolve a module specifier relative to `filePath` against the VFS.
   * Returns the resolved absolute path, or undefined if no file exists.
   */
  resolveSpec: (spec: string, importerPath: string) => Promise<string | undefined>;
}

/**
 * Source-code extensions that must NOT be treated as plain asset URLs.
 * These should go through a regular import or the Worker pattern.
 */
const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
]);

let placeholderCounter = 0;
function nextPlaceholder(prefix: "WORKER" | "ASSET"): string {
  placeholderCounter += 1;
  return `__SHAKESPEARE_${prefix}_URL_${placeholderCounter.toString(36)}__`;
}

/**
 * Scan a source file for Worker / SharedWorker / asset URL patterns.
 * Returns the rewritten source along with the collected matches.
 *
 * Throws with a human-readable message when a problem is found that
 * should fail the build (classic worker, non-literal specifier,
 * unresolvable specifier).
 */
export async function detectWorkersAndAssets(
  options: DetectOptions,
): Promise<DetectResult> {
  const { source, filePath, ext, resolveSpec } = options;

  // Fast path: no `new URL(` anywhere.
  if (!PREFILTER.test(source)) {
    return { code: source, workers: [], assets: [] };
  }

  // Strip TS/JSX so acorn can parse it. We only reach this branch for
  // files that contain `new URL(`, which is rare, so the transform
  // cost is paid for very few files per build.
  let jsSource = source;
  const needsStrip = ext === "ts" || ext === "tsx" || ext === "jsx";
  if (needsStrip) {
    try {
      const esbuild = await getEsbuild();
      const result = await esbuild.transform(source, {
        loader: ext === "ts" ? "ts" : ext === "tsx" ? "tsx" : "jsx",
        sourcemap: false,
        sourcefile: filePath,
        // Preserve the shape of the source as much as possible; we're
        // only using the output to parse, not to emit.
        target: "esnext",
      });
      jsSource = result.code;
    } catch {
      // If the transform itself fails, skip worker detection; esbuild's
      // main pass will surface the syntax error with a proper location.
      return { code: source, workers: [], assets: [] };
    }
  }

  // Parse.
  let ast: acorn.Node;
  try {
    ast = ParserWithJsx.parse(jsSource, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    // If acorn can't parse (possibly because of syntax esbuild supports
    // that acorn doesn't), skip detection and let the main build
    // surface any real error.
    return { code: source, workers: [], assets: [] };
  }

  // Walk the AST to find NewExpression nodes we care about.
  // We operate on the stripped jsSource for position information, but
  // the returned `code` must be the ORIGINAL source with rewrites
  // applied. Since replacements are string-literal values (the first
  // argument of `new URL`), we search for those literals in the
  // original source to do the rewrite. This avoids any dependence on
  // post-TS-strip positions.
  const workers: WorkerMatch[] = [];
  const assets: AssetMatch[] = [];
  // Map spec -> list of { kind: "worker" | "asset", placeholder, resolvedPath }
  // collected during the AST walk. We rewrite afterwards so that each
  // *occurrence* of the spec in the original source that parses back
  // to the same construct gets its own placeholder.
  interface PendingRewrite {
    spec: string;
    kind: "worker" | "asset";
    workerKind?: "Worker" | "SharedWorker";
    resolvedPath: string;
  }
  const pending: PendingRewrite[] = [];

  const seenUrlNodes = new WeakSet<acorn.Node>();

  const walk = async (node: acorn.Node | null | undefined): Promise<void> => {
    if (!node || typeof node !== "object") return;
    // Process this node first (so Worker sees its inner new URL before
    // the asset pass does).
    await visit(node);
    // Recurse into all child nodes.
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            await walk(child as acorn.Node);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        await walk(value as acorn.Node);
      }
    }
  };

  const visit = async (node: acorn.Node): Promise<void> => {
    if (node.type !== "NewExpression") return;
    const newExpr = node as unknown as {
      type: "NewExpression";
      callee: { type: string; name?: string };
      arguments: acorn.Node[];
      start: number;
      end: number;
    };
    const calleeName =
      newExpr.callee.type === "Identifier" ? newExpr.callee.name : undefined;

    if (calleeName === "Worker" || calleeName === "SharedWorker") {
      // new Worker(new URL(<spec>, import.meta.url), <opts>?)
      const [arg0, arg1] = newExpr.arguments;
      if (!isNewUrlWithImportMeta(arg0)) {
        // Not the Vite pattern — leave alone.
        return;
      }
      const urlNode = arg0 as unknown as {
        type: "NewExpression";
        arguments: acorn.Node[];
      };
      const specNode = urlNode.arguments[0];
      if (!isStringLiteral(specNode)) {
        throw new Error(
          `${filePath}: new ${calleeName}(new URL(...)) requires a string literal as the first argument to new URL(). Dynamic specifiers are not supported.`,
        );
      }
      // Require { type: 'module' } as the second argument.
      if (!hasTypeModuleOption(arg1)) {
        throw new Error(
          `${filePath}: new ${calleeName}(new URL(...)) must pass { type: 'module' } as its second argument. Shakespeare does not support classic workers.`,
        );
      }
      const spec = readStringLiteral(specNode)!;
      const resolvedPath = await resolveSpec(spec, filePath);
      if (!resolvedPath) {
        throw new Error(
          `${filePath}: could not resolve worker module '${spec}'.`,
        );
      }
      // Mark the inner `new URL(...)` as "consumed" so the asset pass
      // below doesn't also rewrite it.
      seenUrlNodes.add(arg0);
      pending.push({
        spec,
        kind: "worker",
        workerKind: calleeName,
        resolvedPath,
      });
      return;
    }

    if (calleeName === "URL") {
      if (seenUrlNodes.has(node)) return;
      if (!isNewUrlWithImportMeta(node)) return;
      const specNode = newExpr.arguments[0];
      if (!isStringLiteral(specNode)) {
        // Non-literal `new URL(...)` is legal and common for runtime
        // URL construction. Don't touch it.
        return;
      }
      const spec = readStringLiteral(specNode)!;
      // Only rewrite specs that look like module-relative paths.
      // Anything else (absolute https://, etc.) is almost certainly a
      // runtime URL and not a bundle asset reference.
      if (!isRelativeOrAliasSpec(spec)) return;
      const resolvedPath = await resolveSpec(spec, filePath);
      if (!resolvedPath) {
        // Can't resolve — probably a runtime URL; leave alone.
        return;
      }
      // Skip source files — these should go through normal imports or
      // the Worker pattern.
      const resolvedExt = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
      if (SOURCE_EXTENSIONS.has(resolvedExt)) {
        // Emit a console warning but don't fail the build.
        console.warn(
          `${filePath}: new URL('${spec}', import.meta.url) references a source file. Shakespeare only rewrites non-source assets via this pattern. Use a regular import or new Worker() instead.`,
        );
        return;
      }
      pending.push({ spec, kind: "asset", resolvedPath });
    }
  };

  await walk(ast);

  if (pending.length === 0) {
    return { code: source, workers: [], assets: [] };
  }

  // Now apply the rewrites to the ORIGINAL source by replacing the
  // string-literal spec. Each `pending` entry consumes the first
  // remaining occurrence of its literal form so multiple identical
  // specs each get their own placeholder.
  //
  // Match a quoted literal whose content equals `spec`. We match
  // single quotes, double quotes, or backticks (template literal
  // without interpolation) to cover all reasonable TS/JS source
  // styles.
  let code = source;
  for (const entry of pending) {
    const placeholder = nextPlaceholder(entry.kind === "worker" ? "WORKER" : "ASSET");
    const { literal, index } = findNextSpecLiteral(code, entry.spec);
    if (literal === null || index < 0) {
      // Shouldn't normally happen (we parsed it); be defensive.
      throw new Error(
        `${filePath}: internal error rewriting new URL('${entry.spec}', ...); could not locate the literal in source.`,
      );
    }
    const before = code.slice(0, index);
    const after = code.slice(index + literal.length);
    // Preserve the quote style of the original literal.
    const quote = literal[0];
    code = before + quote + placeholder + quote + after;

    if (entry.kind === "worker") {
      workers.push({
        placeholder,
        resolvedPath: entry.resolvedPath,
        kind: entry.workerKind!,
      });
    } else {
      assets.push({ placeholder, resolvedPath: entry.resolvedPath });
    }
  }

  return { code, workers, assets };
}

function isNewUrlWithImportMeta(node: acorn.Node | null | undefined): boolean {
  if (!node || node.type !== "NewExpression") return false;
  const n = node as unknown as {
    callee: { type: string; name?: string };
    arguments: acorn.Node[];
  };
  if (n.callee.type !== "Identifier" || n.callee.name !== "URL") return false;
  if (n.arguments.length < 2) return false;
  return isImportMetaUrl(n.arguments[1]);
}

function isImportMetaUrl(node: acorn.Node | undefined): boolean {
  if (!node || node.type !== "MemberExpression") return false;
  const m = node as unknown as {
    object: { type: string; meta?: { name?: string }; property?: { name?: string } };
    property: { type: string; name?: string };
    computed: boolean;
  };
  if (m.computed) return false;
  if (m.property.type !== "Identifier" || m.property.name !== "url") return false;
  if (m.object.type !== "MetaProperty") return false;
  if (m.object.meta?.name !== "import") return false;
  if (m.object.property?.name !== "meta") return false;
  return true;
}

function isStringLiteral(node: acorn.Node | undefined): boolean {
  return readStringLiteral(node) !== undefined;
}

function readStringLiteral(node: acorn.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal") {
    const v = (node as unknown as { value: unknown }).value;
    return typeof v === "string" ? v : undefined;
  }
  if (node.type === "TemplateLiteral") {
    const tl = node as unknown as {
      expressions: unknown[];
      quasis: Array<{ value: { cooked?: string } }>;
    };
    if (tl.expressions.length === 0 && tl.quasis.length === 1 &&
        typeof tl.quasis[0].value.cooked === "string") {
      return tl.quasis[0].value.cooked;
    }
  }
  return undefined;
}

function hasTypeModuleOption(node: acorn.Node | undefined): boolean {
  if (!node || node.type !== "ObjectExpression") return false;
  const obj = node as unknown as {
    properties: Array<{
      type: string;
      key: { type: string; name?: string; value?: unknown };
      value: { type: string; value?: unknown };
      computed: boolean;
    }>;
  };
  for (const prop of obj.properties) {
    if (prop.type !== "Property" || prop.computed) continue;
    let keyName: string | undefined;
    if (prop.key.type === "Identifier") {
      keyName = prop.key.name;
    } else if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
      keyName = prop.key.value;
    }
    if (keyName !== "type") continue;
    if (prop.value.type === "Literal" && prop.value.value === "module") {
      return true;
    }
  }
  return false;
}

function isRelativeOrAliasSpec(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    spec.startsWith("@/")
  );
}

/**
 * Find the next occurrence of a string literal with the given content
 * in `source`. Searches for `'spec'`, `"spec"`, and `` `spec` ``. The
 * simplest, correct way: search for each possible quoted form and
 * pick the earliest occurrence.
 */
function findNextSpecLiteral(
  source: string,
  spec: string,
): { literal: string | null; index: number } {
  // Build the three possible source-text forms of the literal.
  const candidates = [
    encodeAsLiteral(spec, "'"),
    encodeAsLiteral(spec, '"'),
    encodeAsLiteral(spec, "`"),
  ];

  let bestIdx = -1;
  let best: string | null = null;
  for (const lit of candidates) {
    const idx = source.indexOf(lit);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx;
      best = lit;
    }
  }
  return { literal: best, index: bestIdx };
}

function encodeAsLiteral(value: string, quote: "'" | '"' | "`"): string {
  // We don't do full JS escape handling — the spec is the parsed
  // (decoded) value of a string literal, so the common case is that
  // the literal appears in source verbatim as quote + value + quote.
  // Escaped characters in the original source (e.g. \n) would
  // de-encode to different bytes and won't match here, which means we
  // fall through to the "internal error" case. In practice worker
  // specs are paths with no escapes, so this is fine.
  return quote + value + quote;
}
