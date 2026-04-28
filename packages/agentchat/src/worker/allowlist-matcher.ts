import picomatch from 'picomatch';

const GLOB_CHARS = /[*?[]/;

export function matchAllowlist(
  yamlList: readonly string[],
  perDispatchCache: ReadonlySet<string>,
  tool_name: string,
): boolean {
  if (perDispatchCache.has(tool_name)) return true;
  for (const pattern of yamlList) {
    if (GLOB_CHARS.test(pattern)) {
      if (picomatch(pattern)(tool_name)) return true;
    } else {
      if (pattern === tool_name) return true;
    }
  }
  return false;
}
