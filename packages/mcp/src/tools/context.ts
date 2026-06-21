import type { HandleStore } from "../handle-store.js";

export interface ToolBuildContext {
  handleStore: HandleStore;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

export type ToolHandler<Args = unknown> = (args: Args) => Promise<ToolResult>;
