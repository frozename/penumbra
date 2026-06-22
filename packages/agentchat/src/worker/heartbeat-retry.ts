export const MAX_HEARTBEAT_ATTEMPTS = 25;

export type HeartbeatRetryDecision =
  | { shouldRetry: false }
  | { shouldRetry: true; delayMs: number; nextAttempt: number };

export function nextHeartbeatRetry(attempt: number): HeartbeatRetryDecision {
  if (attempt >= MAX_HEARTBEAT_ATTEMPTS) {
    return { shouldRetry: false };
  }

  const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
  return {
    shouldRetry: true,
    delayMs,
    nextAttempt: attempt + 1,
  };
}
