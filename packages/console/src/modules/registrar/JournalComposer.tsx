import type { RegistrarEvent, RegistrarEventInput } from "@penumbra/api-contract";

import { useState } from "react";

import type { DaemonClient } from "@src/api/client";
import { useDaemonAction } from "@src/hooks/useDaemonAction";
import { registrarDetail, registrarEvents } from "@src/lib/query-keys";

const BODY_LIMIT_BYTES = 4096;

type ComposerKind = "progress" | "caveat" | "decision";

interface ComposerArgs {
  id: string;
  input: { kind: ComposerKind; body: string };
}

function toEventInput(kind: ComposerKind, body: string): RegistrarEventInput {
  switch (kind) {
    case "caveat":
      return { kind: "caveat", actor: "operator", body };
    case "decision":
      return { kind: "decision", actor: "operator", body };
    case "progress":
      return { kind: "progress", actor: "operator", body };
  }
}

export interface JournalComposerProps {
  registrarId: string;
  client: DaemonClient;
}

export function JournalComposer({ registrarId, client }: JournalComposerProps): JSX.Element {
  const [kind, setKind] = useState<ComposerKind>("progress");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const action = useDaemonAction<ComposerArgs, { event: RegistrarEvent }>(
    {
      id: "registrar-append-event",
      tier: "safe",
      label: "Add journal entry",
      run: (c, { id, input }) => c.registrar.appendEvent(id, toEventInput(input.kind, input.body)),
      invalidate: ({ id }) => [registrarEvents(id), registrarDetail(id)],
    },
    { client },
  );

  const trimmed = body.trim();
  const bytes = new TextEncoder().encode(trimmed).byteLength;
  const overLimit = bytes > BODY_LIMIT_BYTES;

  const submit = async (): Promise<void> => {
    if (overLimit || trimmed.length === 0) return;
    setBusy(true);
    try {
      const res = await action.execute({ id: registrarId, input: { kind, body: trimmed } });
      if (res !== undefined) setBody("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="journal-composer"
      style={{
        padding: "10px 14px",
        display: "grid",
        gap: 8,
        borderTop: "1px solid var(--color-border-subtle)",
      }}
    >
      <textarea
        data-testid="journal-composer-body"
        aria-label="Journal entry body"
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
        }}
        rows={3}
        style={{ resize: "vertical", font: "inherit" }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          data-testid="journal-composer-kind"
          aria-label="Journal entry kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ComposerKind);
          }}
        >
          <option value="progress">Progress</option>
          <option value="caveat">Caveat</option>
          <option value="decision">Decision</option>
        </select>
        <span
          data-testid="journal-composer-bytes"
          className="mono"
          style={{
            fontSize: 10.5,
            color: overLimit ? "var(--color-err)" : "var(--color-text-tertiary)",
          }}
        >
          {bytes} / 4096 bytes
        </span>
        <button
          type="button"
          data-testid="journal-composer-add"
          className="btn btn-primary"
          disabled={overLimit || trimmed.length === 0 || action.isPending || busy}
          onClick={() => {
            void submit();
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
