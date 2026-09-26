const [counter] = [{ calls: 0 }];

export function bump(): number {
  counter.calls += 1;
  return counter.calls;
}
