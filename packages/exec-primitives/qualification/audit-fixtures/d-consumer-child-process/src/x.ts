import { execFile } from "node:child_process";
import { superviseProcess } from "penumbra-exec-primitives";
export const x = execFile;
export const y = superviseProcess;
