import type { ErasedQueue } from "./types";

import { draftsQueue } from "./drafts";
import { handoffsQueue } from "./handoffs";
import { permissionsQueue } from "./permissions";

export type { ApprovalItem, ErasedQueue } from "./types";

export const QUEUES: readonly ErasedQueue[] = [handoffsQueue, permissionsQueue, draftsQueue];
