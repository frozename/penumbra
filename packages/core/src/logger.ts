import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(opts: {
  component: string;
  level?: pino.Level | 'silent';
}): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { component: opts.component },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
