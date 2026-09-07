import { useLiveQuery } from "./useLiveQuery.js";

// prettier-ignore
// @ts-expect-error patch is not an option
useLiveQuery({ queryKey: ["x"], queryFn: (): Promise<number> => Promise.resolve(1), owner: "mission", patch: true });
