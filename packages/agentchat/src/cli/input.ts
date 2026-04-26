export type InputEvent = { kind: 'message'; text: string } | { kind: 'done' };

export async function* parseInputStream(lines: AsyncIterable<string>): AsyncIterable<InputEvent> {
  let buffer: string[] = [];
  for await (const raw of lines) {
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
