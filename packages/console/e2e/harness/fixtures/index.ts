import type { FixtureRouter } from "../router";
import type { HarnessState } from "../server";
import { register as registerChains } from "./chains";
import { register as registerHandoffs } from "./handoffs";
import { register as registerMission } from "./mission";
import { register as registerPermissions } from "./permissions";
import { register as registerRegistrar } from "./registrar";
import { register as registerSessions } from "./sessions";

export const FIXTURES = [
  registerMission,
  registerRegistrar,
  registerSessions,
  registerPermissions,
  registerHandoffs,
  registerChains,
] as const;

export type FixtureRegistrar = (router: FixtureRouter, state: HarnessState) => void;
