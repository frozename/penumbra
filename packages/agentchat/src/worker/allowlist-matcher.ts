import picomatch from 'picomatch';

export function matchAllowlist(
  yamlList: readonly string[],
  perDispatchCache: ReadonlySet<string>,
  tool_name: string,
): boolean {
  if (perDispatchCache.has(tool_name)) return true;
  for (const pattern of yamlList) {
    if (picomatch(pattern)(tool_name)) return true;
  }
  return false;
}
