import type { Logger } from "@penumbra/core";

import { load as yamlLoad } from "js-yaml";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const { resolveOperatorConfigPath } = createRequire(import.meta.url)(
  "../../../config/src/files/operator-paths.js",
) as {
  resolveOperatorConfigPath: (filename: string, env: Record<string, string | undefined>) => string;
};

export const ExtraWorkerSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "invalid extra worker id"),
    concurrency: z.number().int().positive().max(32).optional(),
    project_id: z.string().min(1).optional(),
    isolation: z.enum(["sticky", "hard", "shared"]).optional(),
  })
  .superRefine((extra, ctx) => {
    if ((extra.isolation === "hard" || extra.isolation === "sticky") && !extra.project_id) {
      ctx.addIssue({
        code: "custom",
        path: ["isolation"],
        message: `isolation=${extra.isolation} requires project_id`,
      });
    }
  })
  .strict();

const ExtraWorkersConfigFileSchema = z.object({
  extras: z.array(ExtraWorkerSchema).max(32).default([]),
});

export type ExtraWorkerConfig = {
  id: string;
  concurrency: number;
  isolation: "sticky" | "hard" | "shared";
  project_id?: string;
};

export type ExtraWorkersConfig = {
  extras: ExtraWorkerConfig[];
};

type ProjectRegistryLike = { has(id: string): boolean };

export class ExtraWorkersConfigError extends Error {
  constructor(
    message: string,
    public filePath: string,
  ) {
    super(`extra workers ${filePath}: ${message}`);
    this.name = "ExtraWorkersConfigError";
  }
}

export interface ExtraWorkersConfigOptions {
  projectRegistry?: ProjectRegistryLike;
  log?: Logger;
}

function readPrimaryWorkerId(): string | undefined {
  const home = process.env.HOME ?? homedir();
  const idPath = join(home, ".penumbra", "worker-id");
  if (!existsSync(idPath)) return undefined;
  const raw = readFileSync(idPath, "utf8");
  return raw.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readWorkersConfigFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw new ExtraWorkersConfigError(errorMessage(error), path);
  }
}

function parseWorkersConfigYaml(raw: string, path: string): unknown {
  try {
    return yamlLoad(raw);
  } catch (error: unknown) {
    throw new ExtraWorkersConfigError(errorMessage(error), path);
  }
}

type ParsedWorkersConfigFile = { extras: z.infer<typeof ExtraWorkerSchema>[] };

function validateWorkersConfig(parsed: unknown, path: string): ParsedWorkersConfigFile {
  try {
    return ExtraWorkersConfigFileSchema.parse(parsed);
  } catch (error: unknown) {
    throw new ExtraWorkersConfigError(errorMessage(error), path);
  }
}

function logUnknownProject(opts: ExtraWorkersConfigOptions, resolved: ExtraWorkerConfig): void {
  const warning = {
    event: "extra_worker_unknown_project",
    worker_id: resolved.id,
    project_id: resolved.project_id,
  };
  if (opts.log) {
    opts.log.warn(warning, "extra worker references unknown project_id and will be skipped");
  } else {
    console.warn(warning);
  }
}

function resolveExtraWorker(extra: z.infer<typeof ExtraWorkerSchema>): ExtraWorkerConfig {
  return {
    id: extra.id,
    concurrency: extra.concurrency ?? 4,
    isolation: extra.isolation ?? (extra.project_id !== undefined ? "sticky" : "shared"),
    project_id: extra.project_id,
  };
}

export function loadExtraWorkersConfig(opts: ExtraWorkersConfigOptions = {}): ExtraWorkersConfig {
  const path = resolveOperatorConfigPath("workers.yaml", process.env);
  const raw = readWorkersConfigFile(path);
  if (raw === null) return { extras: [] };

  const parsed = parseWorkersConfigYaml(raw, path);
  const file = validateWorkersConfig(parsed, path);

  const primaryWorkerId = readPrimaryWorkerId();
  const seen = new Set<string>();
  const extras: ExtraWorkerConfig[] = [];

  for (const extra of file.extras) {
    if (seen.has(extra.id)) {
      throw new ExtraWorkersConfigError(`duplicate extra worker id ${extra.id}`, path);
    }
    seen.add(extra.id);

    if (primaryWorkerId !== undefined && extra.id === primaryWorkerId) {
      throw new ExtraWorkersConfigError(
        `extra worker id ${extra.id} collides with primary worker id`,
        path,
      );
    }

    const resolved = resolveExtraWorker(extra);

    if (
      resolved.project_id !== undefined &&
      opts.projectRegistry?.has(resolved.project_id) === false
    ) {
      logUnknownProject(opts, resolved);
      continue;
    }

    extras.push(resolved);
  }

  return { extras };
}
