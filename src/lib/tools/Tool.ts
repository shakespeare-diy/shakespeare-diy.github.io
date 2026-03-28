import type z from "zod";

export interface ToolResultImage {
  type: 'image';
  url: string; // data URL (e.g. data:image/png;base64,...)
}

export interface ToolResult {
  content: string;
  cost?: number;
  images?: ToolResultImage[];
}

export interface Tool<TParams> {
  description: string;
  inputSchema?: z.ZodType<TParams>;
  execute(args: TParams): Promise<ToolResult>;
}
