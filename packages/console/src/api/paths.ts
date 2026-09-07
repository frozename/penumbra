export function fillPath(template: string, params: Record<string, string> = {}): string {
  return template.replaceAll(/:([A-Za-z_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`fillPath: missing param ${name} for ${template}`);
    return encodeURIComponent(v);
  });
}
