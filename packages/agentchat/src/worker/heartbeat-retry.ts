export const MAX_HEARTBEAT_ATTEMPTS = 25;

export function nextHeartbeatRetry(attempt: number): {
  shouldRetry: boolean;
  delayMs?: number;
  nextAttempt?: number;
} {
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
