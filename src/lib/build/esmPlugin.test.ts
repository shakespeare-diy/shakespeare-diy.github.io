import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isEffectivelyEmptyModule,
  resolveEmptyModuleFallback,
  stripAssetUrlWildcard,
} from "./esmPlugin";

describe("stripAssetUrlWildcard", () => {
  it("strips esm.sh's leading /* wildcard prefix from asset URLs", () => {
    expect(
      stripAssetUrlWildcard(
        "https://esm.sh/*@fontsource/playfair-display@5.2.8/files/x.woff2",
      ),
    ).toBe("https://esm.sh/@fontsource/playfair-display@5.2.8/files/x.woff2");
  });

  it("preserves the query string (e.g. the lp breadcrumb)", () => {
    expect(
      stripAssetUrlWildcard(
        "https://esm.sh/*@fontsource/foo@1/files/y.woff?lp=node_modules%252F%2540fontsource%252Ffoo",
      ),
    ).toBe(
      "https://esm.sh/@fontsource/foo@1/files/y.woff?lp=node_modules%252F%2540fontsource%252Ffoo",
    );
  });

  it("leaves URLs without a wildcard prefix unchanged", () => {
    const url = "https://esm.sh/@fontsource/foo@1/files/y.woff2?lp=abc";
    expect(stripAssetUrlWildcard(url)).toBe(url);
  });

  it("only strips a leading /* in the path, not a * elsewhere", () => {
    const url = "https://esm.sh/@scope/pkg@1/a*b/file.woff2";
    expect(stripAssetUrlWildcard(url)).toBe(url);
  });

  it("returns the input unchanged when it is not a valid URL", () => {
    expect(stripAssetUrlWildcard("not a url")).toBe("not a url");
  });

  it("produces a url() value with no literal /* (the Tailwind tokenizer trap)", () => {
    const fixed = stripAssetUrlWildcard(
      "https://esm.sh/*@fontsource/playfair-display@5.2.8/files/x.woff2",
    );
    expect(`src: url(${fixed})`).not.toContain("/*");
  });
});

describe("isEffectivelyEmptyModule", () => {
  it("treats a file with only source-map comments as empty", () => {
    const source =
      "\n//# sourceMappingURL=index.browser.mjs.map\n//# sourceMappingURL=index.browser.mjs.map";
    expect(isEffectivelyEmptyModule(source)).toBe(true);
  });

  it("treats a jsDelivr-bannered empty bundle as empty", () => {
    const source = [
      "/**",
      " * Bundled by jsDelivr using Rollup v2.79.2 and Terser v5.48.0.",
      " * Original file: /npm/@solana/rpc-parsed-types@6.9.0/dist/index.browser.mjs",
      " */",
      "//# sourceMappingURL=/sm/abc.map",
    ].join("\n");
    expect(isEffectivelyEmptyModule(source)).toBe(true);
  });

  it("treats a 'use strict' prologue with no code as empty", () => {
    expect(isEffectivelyEmptyModule("'use strict';\n//# sourceMappingURL=x.map")).toBe(true);
  });

  it("treats a bare `export {};` as empty", () => {
    expect(isEffectivelyEmptyModule("export {};")).toBe(true);
  });

  it("does not treat a module with real exports as empty", () => {
    expect(isEffectivelyEmptyModule("export const x = 1;")).toBe(false);
  });

  it("does not treat a module with imports as empty", () => {
    expect(isEffectivelyEmptyModule("import './side-effect.js';")).toBe(false);
  });

  it("does not treat a module with executable code as empty", () => {
    expect(isEffectivelyEmptyModule("console.log('hi');")).toBe(false);
  });
});

describe("resolveEmptyModuleFallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("synthesizes an empty module when jsDelivr runtime is empty", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "\n//# sourceMappingURL=index.browser.mjs.map",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveEmptyModuleFallback(
      "https://esm.sh/*@solana/rpc-parsed-types?target=esnext",
      new Map(),
    );

    expect(result).toBe("export {};\n");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.jsdelivr.net/npm/@solana/rpc-parsed-types/+esm",
    );
  });

  it("recovers the version from the lockfile index", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "//# sourceMappingURL=x.map",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const nameVersionToPaths = new Map<string, string[]>([
      ["@solana/rpc-parsed-types@6.9.0", ["node_modules/@solana/rpc-parsed-types"]],
    ]);

    await resolveEmptyModuleFallback(
      "https://esm.sh/*@solana/rpc-parsed-types?target=esnext",
      nameVersionToPaths,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.jsdelivr.net/npm/@solana/rpc-parsed-types@6.9.0/+esm",
    );
  });

  it("returns undefined for a non-empty package (does not mask real failures)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "export const isNumber = () => true;",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveEmptyModuleFallback(
      "https://esm.sh/*is-number@7.0.0?target=esnext",
      new Map(),
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined when the jsDelivr fallback also fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveEmptyModuleFallback(
      "https://esm.sh/*@solana/rpc-parsed-types?target=esnext",
      new Map(),
    );

    expect(result).toBeUndefined();
  });

  it("does not attempt recovery for non-JS asset requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveEmptyModuleFallback(
      "https://esm.sh/some-pkg@1.0.0/styles.css?target=esnext",
      new Map(),
    );

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
