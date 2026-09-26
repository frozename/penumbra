const nextId = ((): (() => number) => {
  let n = 0;
  return () => ++n;
})();

export function id(): number {
  return nextId();
}
