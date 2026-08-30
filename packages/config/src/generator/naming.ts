/**
 * Deterministic seat-name generation for the roster generator (P4), plus the
 * assertion that guards the one way a generated name can silently misroute.
 *
 * `resolveInitialRoute` (packages/daemon/src/routes/chains.ts) prefers a
 * role-tag match over an exact seat-name match whenever `forceExactAgent` is
 * false (i.e. the caller did not pin with the `agent:` prefix): if a
 * generated seat's name happens to equal a live `roles` tag such as
 * `executor` or `reviewer`, a dispatch aimed at that literal seat is silently
 * role-routed to whichever agent holds that role instead. `seatNameFor`'s
 * output must never collide with a role tag, and `assertNoRoleTagCollision`
 * is the fail-closed check the generator runs before writing any seat.
 *
 * Canonical scheme: lowercase, hyphen-joined `source-modelSlug[-effort]`,
 * with every character outside `[a-z0-9]` (dots, slashes, underscores,
 * whitespace, ...) collapsed to a single hyphen. This matches the seat-name
 * shape already in use across the fleet (e.g. `claude-acp-sonnet`,
 * `sakana-fugu-http`) and the canonical-lowercase-hyphenated convention this
 * package already applies to provider values (provider-format.ts).
 *
 * That same collapsing means distinct inputs can normalize to the same name
 * (`gpt-5.5` and `gpt-5-5` both become `gpt-5-5`); `assertUniqueSeatNames` is
 * the fail-closed check for that inter-slug collision, run across all inputs
 * before any seat is written.
 */

function normalizeSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/** Deterministic, pure seat name for a generated (source, model slug, effort) tuple. */
export function seatNameFor(source: string, modelSlug: string, effort?: string): string {
  const segments = [source, modelSlug, effort]
    .filter((segment): segment is string => Boolean(segment))
    .map(normalizeSegment)
    .filter((segment) => segment.length > 0);
  const name = segments.join("-");
  if (name.length === 0) {
    throw new Error(
      `seatNameFor(${JSON.stringify(source)}, ${JSON.stringify(modelSlug)}${
        effort !== undefined ? `, ${JSON.stringify(effort)}` : ""
      }) normalizes to an empty seat name — every character was outside [a-z0-9]`,
    );
  }
  return name;
}

/** A single (source, model slug, effort) tuple the generator is about to name a seat from. */
export interface SeatNameInput {
  readonly source: string;
  readonly modelSlug: string;
  readonly effort?: string;
}

function describeSeatNameInput(input: SeatNameInput): string {
  return `(source=${JSON.stringify(input.source)}, modelSlug=${JSON.stringify(input.modelSlug)}${
    input.effort !== undefined ? `, effort=${JSON.stringify(input.effort)}` : ""
  })`;
}

/**
 * Throws (aggregating every offending seat name into one error) when two or
 * more distinct inputs normalize to the same seat name via `seatNameFor` —
 * e.g. model slugs `gpt-5.5` and `gpt-5-5` both collapse to `gpt-5-5`, so two
 * genuinely different models would otherwise silently share one seat.
 */
export function assertUniqueSeatNames(inputs: readonly SeatNameInput[]): void {
  const groups = new Map<string, SeatNameInput[]>();
  for (const input of inputs) {
    const name = seatNameFor(input.source, input.modelSlug, input.effort);
    const group = groups.get(name);
    if (group) {
      group.push(input);
    } else {
      groups.set(name, [input]);
    }
  }

  // Identical (source, modelSlug, effort) tuples are one logical seat (shared
  // AA pairs are by-design), not a collision — only distinct raw inputs that
  // normalize to the same name collide.
  const collisions = [...groups.entries()]
    .map(([name, group]): [string, SeatNameInput[]] => {
      const distinct = new Map(group.map((input) => [describeSeatNameInput(input), input]));
      return [name, [...distinct.values()]];
    })
    .filter(([, group]) => group.length > 1);
  if (collisions.length === 0) {
    return;
  }

  const details = collisions
    .map(([name, group]) => `"${name}" <- ${group.map(describeSeatNameInput).join(" vs ")}`)
    .join("; ");

  throw new Error(
    `generated seat name(s) collide across distinct inputs after normalization: ${details}`,
  );
}

/**
 * Throws (aggregating every offending name into one error) when any
 * generated seat name is identical to a live role tag.
 */
export function assertNoRoleTagCollision(
  names: readonly string[],
  roleTags: readonly string[],
): void {
  const roleTagSet = new Set(roleTags);
  const collisions = names.filter((name) => roleTagSet.has(name));
  if (collisions.length > 0) {
    throw new Error(
      `generated seat name(s) collide with live role tag(s), which would silently ` +
        `role-route an exact-name dispatch instead of hitting the named seat: ${collisions.join(", ")}`,
    );
  }
}
