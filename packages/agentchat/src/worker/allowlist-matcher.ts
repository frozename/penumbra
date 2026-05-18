import picomatch from 'picomatch';
import { colonFormToSdkPattern } from './mcp-tool-name.js';

export function matchAllowlist(
  yamlList: readonly string[],
  perDispatchCache: ReadonlySet<string>,
  tool_name: string,
): boolean {
  if (perDispatchCache.has(tool_name)) return true;
  for (const pattern of yamlList) {
    const sdkPattern = colonFormToSdkPattern(pattern);
    if (picomatch(sdkPattern)(tool_name)) return true;
  }
  return false;
}
