export type McpInvoker = (
  tool: string,
  input: Record<string, unknown> | undefined,
) => Promise<unknown>;

export async function runMcpToolSource(opts: {
  invokeMcpTool: McpInvoker;
  args: { tool: string; input?: Record<string, unknown> };
}): Promise<{ result: unknown; warnings: string[] }> {
  try {
    const result = await opts.invokeMcpTool(opts.args.tool, opts.args.input);
    return { result, warnings: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: null, warnings: [`mcp.tool ${opts.args.tool}: ${msg}`] };
  }
}
