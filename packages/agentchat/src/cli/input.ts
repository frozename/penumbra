export type InputEvent = { kind: 'message'; text: string } | { kind: 'done' };

export async function* parseInputStream(iterator: AsyncIterator<string>): AsyncIterable<InputEvent> {
  let buffer: string[] = [];
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    const raw = value as string;
    const line = raw.trim();
    if (line === 'done' && buffer.length === 0) { 
      yield { kind: 'done' }; 
      return; 
    }
    if (line === '') {
      if (buffer.length > 0) { 
        yield { kind: 'message', text: buffer.join('\n') }; 
        buffer = []; 
      }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) {
    yield { kind: 'message', text: buffer.join('\n') };
  }
}
