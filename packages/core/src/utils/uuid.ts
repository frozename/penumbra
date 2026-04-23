import { randomUUID } from 'node:crypto';

export type Uuid = () => string;
export const systemUuid: Uuid = () => randomUUID();
