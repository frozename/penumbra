const PATTERNS: { re: RegExp }[] = [{ re: /x/ }];
export function matchesAll(s: string): boolean {
  return PATTERNS.every((p) => p.re.test(s));
}
