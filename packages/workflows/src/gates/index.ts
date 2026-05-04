export type GateInput = {
  text?: string;
  dispatchResult?: { stdout?: string; stderr?: string; outcome?: string };
  conversationMemory?: string[];
  spec?: { use_worktree?: boolean };
};

export type GateSeverity = 'advisory' | 'blocking-in-session' | 'triggers-retry';

export type GateResult = {
  passed: boolean;
  evidence: string;
  severity: GateSeverity;
};

export type GateName =
  | 'verification-before-complete'
  | 'tdd'
  | 'brainstorm-first'
  | 'worktree-isolation';

export type GateVerifier = (input: GateInput) => GateResult;

export { verifyVerificationBeforeComplete } from './verification-before-complete.js';
export { verifyTdd } from './tdd.js';
export { verifyBrainstormFirst } from './brainstorm-first.js';
export { verifyWorktreeIsolation } from './worktree-isolation.js';

import { verifyVerificationBeforeComplete } from './verification-before-complete.js';
import { verifyTdd } from './tdd.js';
import { verifyBrainstormFirst } from './brainstorm-first.js';
import { verifyWorktreeIsolation } from './worktree-isolation.js';

export const GATES: Record<GateName, GateVerifier> = {
  'verification-before-complete': verifyVerificationBeforeComplete,
  'tdd': verifyTdd,
  'brainstorm-first': verifyBrainstormFirst,
  'worktree-isolation': verifyWorktreeIsolation,
};
