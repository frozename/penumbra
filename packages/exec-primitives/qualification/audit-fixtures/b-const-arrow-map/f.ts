const HANDLERS: Map<string, () => void> = new Map();
export function handlerCount(): number {
  return HANDLERS.size;
}
