import { useEffect, useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

import { ApprovalsInbox } from "./ApprovalsInbox";

export interface ApprovalsViewProps {
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function ApprovalsView(props: ApprovalsViewProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  useEffect(() => {
    setActiveModule("approvals");
  }, [setActiveModule]);
  return <ApprovalsInbox client={client} />;
}

export { ApprovalsInbox };
export type { ApprovalsInboxProps } from "./ApprovalsInbox";
