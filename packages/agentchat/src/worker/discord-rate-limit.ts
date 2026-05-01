export interface DiscordRateLimiterOptions {
  now: () => number;
  windowMs: number;
}

export interface DiscordRateLimiterDecision {
  webhookKey: string;
  coalesceKey?: string;
}

export interface DiscordRateLimiter {
  shouldSend(input: DiscordRateLimiterDecision): boolean;
}

export function createDiscordRateLimiter(options: DiscordRateLimiterOptions): DiscordRateLimiter {
  const lastSentAt = new Map<string, number>();

  const keyFor = (webhookKey: string, coalesceKey: string): string => `${webhookKey}\u0000${coalesceKey}`;

  const sweepExpired = (now: number) => {
    if (options.windowMs <= 0) {
      lastSentAt.clear();
      return;
    }

    for (const [key, sentAt] of lastSentAt) {
      if (now - sentAt >= options.windowMs) {
        lastSentAt.delete(key);
      }
    }
  };

  return {
    shouldSend({ webhookKey, coalesceKey }) {
      if (!coalesceKey) return true;

      const now = options.now();
      sweepExpired(now);

      const key = keyFor(webhookKey, coalesceKey);
      const sentAt = lastSentAt.get(key);
      if (sentAt !== undefined && now - sentAt < options.windowMs) {
        return false;
      }

      lastSentAt.set(key, now);
      return true;
    },
  };
}
