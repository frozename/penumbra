import { useEffect, useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

import { HandoffDetail } from "./HandoffDetail";
import { HandoffList } from "./HandoffList";

export interface HandoffsViewProps {
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function HandoffsView(props: HandoffsViewProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  useEffect(() => {
    setActiveModule("handoffs");
  }, [setActiveModule]);
  return <HandoffList client={client} />;
}

export { HandoffDetail, HandoffList };
export type { HandoffDetailProps } from "./HandoffDetail";
export type { HandoffListProps } from "./HandoffList";
