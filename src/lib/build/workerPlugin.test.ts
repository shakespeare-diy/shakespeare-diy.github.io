import { describe, it, expect, vi } from "vitest";

// Mock getEsbuild so we can unit-test detection without the real wasm.
// The mock's transform is loader-aware: for "ts"/"tsx"/"jsx" it strips
// obvious TS/JSX constructs enough for acorn to parse. In practice, if
// the input is already valid JS, we just pass it through.
vi.mock("@/lib/esbuild", () => ({
  getEsbuild: vi.fn(async () => ({
    transform: vi.fn(async (source: string) => ({ code: source })),
  })),
}));

import { detectWorkersAndAssets } from "./workerPlugin";

const identityResolver = async (spec: string, importer: string): Promise<string | undefined> => {
  // A trivial resolver that pretends any relative/@ spec resolves to
  // an absolute path. Extension determines whether it's a source file.
  if (spec.startsWith("./") || spec.startsWith("../")) {
    // Pretend to resolve by dropping the leading segment.
    return importer.replace(/[^/]+$/, "") + spec.replace(/^\.\/?/, "");
  }
  if (spec.startsWith("@/")) {
    return "/project/src/" + spec.slice(2);
  }
  if (spec.startsWith("/")) {
    return spec;
  }
  return undefined;
};

describe("detectWorkersAndAssets", () => {
  it("returns source unchanged when file contains no `new URL(`", async () => {
    const source = `
      import React from 'react';
      export const x = 1;
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.code).toBe(source);
    expect(result.workers).toEqual([]);
    expect(result.assets).toEqual([]);
  });

  it("detects a module Worker with @/ alias specifier", async () => {
    const source = [
      "const w = new Worker(",
      "  new URL('@/workers/my-worker.ts', import.meta.url),",
      "  { type: 'module' },",
      ");",
    ].join("\n");
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].resolvedPath).toBe("/project/src/workers/my-worker.ts");
    expect(result.workers[0].kind).toBe("Worker");
    // Placeholder should appear in the rewritten code.
    expect(result.code).toContain(result.workers[0].placeholder);
    // Original spec string should be gone.
    expect(result.code).not.toContain("@/workers/my-worker.ts");
    // import.meta.url reference should be preserved.
    expect(result.code).toContain("import.meta.url");
  });

  it("detects a SharedWorker", async () => {
    const source = `
      const w = new SharedWorker(
        new URL('./w.ts', import.meta.url),
        { type: 'module' },
      );
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0].kind).toBe("SharedWorker");
  });

  it("errors on classic (non-module) worker", async () => {
    const source = `
      const w = new Worker(new URL('./w.ts', import.meta.url));
    `;
    await expect(
      detectWorkersAndAssets({
        source,
        filePath: "/project/src/a.ts",
        ext: "ts",
        resolveSpec: identityResolver,
      }),
    ).rejects.toThrow(/type: 'module'/);
  });

  it("errors on non-literal worker specifier", async () => {
    const source = `
      const p = './dyn.ts';
      const w = new Worker(new URL(p, import.meta.url), { type: 'module' });
    `;
    await expect(
      detectWorkersAndAssets({
        source,
        filePath: "/project/src/a.ts",
        ext: "ts",
        resolveSpec: identityResolver,
      }),
    ).rejects.toThrow(/string literal/i);
  });

  it("errors when worker specifier does not resolve", async () => {
    const source = `
      const w = new Worker(new URL('./missing.ts', import.meta.url), { type: 'module' });
    `;
    await expect(
      detectWorkersAndAssets({
        source,
        filePath: "/project/src/a.ts",
        ext: "ts",
        resolveSpec: async () => undefined,
      }),
    ).rejects.toThrow(/could not resolve worker module/i);
  });

  it("detects plain new URL() asset and rewrites it", async () => {
    const source = `
      const u = new URL('./logo.svg', import.meta.url);
      console.log(u);
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].resolvedPath).toBe("/project/src/logo.svg");
    expect(result.code).toContain(result.assets[0].placeholder);
    expect(result.code).not.toContain("./logo.svg");
  });

  it("does not rewrite plain new URL() when target is a source file", async () => {
    const source = `
      const u = new URL('./thing.ts', import.meta.url);
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.assets).toEqual([]);
    expect(result.code).toBe(source);
  });

  it("does not rewrite new URL() with a non-literal first argument", async () => {
    const source = `
      const p = './thing.svg';
      const u = new URL(p, import.meta.url);
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.assets).toEqual([]);
    expect(result.workers).toEqual([]);
    expect(result.code).toBe(source);
  });

  it("does not rewrite new URL() with an absolute https:// spec", async () => {
    const source = `
      const u = new URL('https://example.com/x.png', import.meta.url);
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.assets).toEqual([]);
    expect(result.code).toBe(source);
  });

  it("does not double-rewrite the inner new URL() of a Worker", async () => {
    const source = `
      const w = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });
    `;
    // Resolver returns a non-source extension for './w.ts' would
    // otherwise ambiguously pull the inner URL into the asset pass.
    // Using ts extension makes it unambiguous: worker match only.
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toHaveLength(1);
    expect(result.assets).toHaveLength(0);
  });

  it("handles both workers and assets in the same file", async () => {
    const source = `
      const img = new URL('./logo.png', import.meta.url);
      const w = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toHaveLength(1);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].resolvedPath).toBe("/project/src/logo.png");
    expect(result.workers[0].resolvedPath).toBe("/project/src/w.ts");
    // Both placeholders present.
    expect(result.code).toContain(result.workers[0].placeholder);
    expect(result.code).toContain(result.assets[0].placeholder);
  });

  it("does not match patterns inside string literals", async () => {
    const source = [
      "const s = \"new Worker(new URL('./w.ts', import.meta.url), { type: 'module' })\";",
    ].join("\n");
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toEqual([]);
    expect(result.assets).toEqual([]);
    expect(result.code).toBe(source);
  });

  it("does not match patterns inside line comments", async () => {
    const source = [
      "// const w = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });",
      "export const x = 1;",
    ].join("\n");
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toEqual([]);
    expect(result.code).toBe(source);
  });

  it("supports double-quoted specifiers", async () => {
    const source = `
      const w = new Worker(new URL("./w.ts", import.meta.url), { type: "module" });
    `;
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toHaveLength(1);
    expect(result.code).toContain(result.workers[0].placeholder);
  });

  it("supports backtick-quoted specifiers with no interpolation", async () => {
    const source = [
      "const w = new Worker(new URL(`./w.ts`, import.meta.url), { type: 'module' });",
    ].join("\n");
    const result = await detectWorkersAndAssets({
      source,
      filePath: "/project/src/a.ts",
      ext: "ts",
      resolveSpec: identityResolver,
    });
    expect(result.workers).toHaveLength(1);
  });
});
