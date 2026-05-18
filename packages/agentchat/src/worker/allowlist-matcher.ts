import picomatch from 'picomatch';
import { colonFormToSdkPattern } from './mcp-tool-name.js';

export function matchAllowlist(
  yamlList: readonly string[],
  perDispatchCache: ReadonlySet<string>,
  tool_name: string,
  precomputedSdkPatterns?: readonly string[],
): boolean {
  if (perDispatchCache.has(tool_name)) return true;
  const sdkPatterns = precomputedSdkPatterns ?? yamlList.map((pattern) => colonFormToSdkPattern(pattern));
  for (const sdkPattern of sdkPatterns) {
    if (picomatch(sdkPattern)(tool_name)) return true;
  }
  return false;
}
