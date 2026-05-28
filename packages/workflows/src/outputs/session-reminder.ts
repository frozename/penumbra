export type SessionReminderOutput = { kind: "session-reminder"; text: string };

export function emitSessionReminder(opts: { text: string }): SessionReminderOutput {
  return { kind: "session-reminder", text: opts.text };
}
