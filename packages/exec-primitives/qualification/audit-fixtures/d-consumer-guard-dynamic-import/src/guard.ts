import "penumbra-exec-primitives";

export async function tripwire(): Promise<void> {
  await import("@penumbra/core");
}
