export class Probe {
  static calls = 0;

  static bump(): number {
    Probe.calls += 1;
    return Probe.calls;
  }
}
