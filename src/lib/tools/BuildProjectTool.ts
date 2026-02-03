import type { Tool, ToolResult } from "./Tool";
import type { JSRuntimeFS } from "../JSRuntime";
import { buildProject } from "../build";

export class BuildProjectTool implements Tool<void> {
  private fs: JSRuntimeFS;
  private cwd: string;
  private esmUrl: string;

  readonly description = "Build the project using esbuild-wasm. Creates optimized production files in the dist directory, making the site preview visible to the user (or updating the existing preview) and ready for deployment. This tool also helps verify that your changes are correct. ALWAYS call this tool when you have finished making changes.";

  constructor(fs: JSRuntimeFS, cwd: string, esmUrl: string) {
    this.fs = fs;
    this.cwd = cwd;
    this.esmUrl = esmUrl;
  }

  async execute(): Promise<ToolResult> {
    try {
      // Build and write the project files
      const result = await buildProject({
        esmUrl: this.esmUrl,
        fs: this.fs,
        projectPath: this.cwd,
        domParser: new DOMParser(),
      });

      const fileCount = Object.keys(result.files).length;
      const fileList = Object.keys(result.files).map(file => `  📄 ${file}`).join('\n');

      return {
        content: `✅ Successfully built project!\n\n📁 Output: ${result.outputPath}\n📦 Files generated: ${fileCount}\n\n${fileList}\n\n🚀 Your project is ready for deployment!`
      };
    } catch (error) {
      throw new Error(`❌ Build failed: ${String(error)}`);
    }
  }
}