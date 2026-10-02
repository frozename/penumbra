import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

GlobalRegistrator.register();

// Unmount after every test in every file. Registered from the preload so it is
// global: a file that renders without its own cleanup otherwise leaves its tree
// in the shared document for whichever file runs next.
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);
