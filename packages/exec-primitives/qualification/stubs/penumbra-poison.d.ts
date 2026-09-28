// Compile-time stub for the qualification tsconfigs: consumer [GUARD] tests
// dynamically import @penumbra/core to prove the runtime poison stub wins.
// Without this paths target, tsc would resolve the workspace link and pull
// all of packages/core into the program. Runtime never sees this file.
export {};
