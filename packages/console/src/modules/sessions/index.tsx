import { useMemo } from "react";
import { DaemonClient } from "@src/api/client";
import { useDaemonStore } from "@src/stores/daemon-store";
import { PendingDraft } from "./PendingDraft";
import type { PendingDraftProps } from "./PendingDraft";
import { SessionTimeline } from "./SessionTimeline";
import type { SessionTimelineProps } from "./SessionTimeline";

export interface SessionsViewProps {
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function SessionsView(props: SessionsViewProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  return (
    <>
      <header className="surface-head">
        <h1>
          Sessions <em>· continuity</em>
        </h1>
        <p className="lede">Daemon session continuity events and pending note drafts.</p>
      </header>
      <PendingDraft client={client} />
      <SessionTimeline client={client} />
    </>
  );
}

export { PendingDraft, SessionTimeline };
export type { PendingDraftProps, SessionTimelineProps };
