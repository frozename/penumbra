import type { FixtureRouter } from "../router";
import type { HarnessState } from "../server";
import { register as registerMission } from "./mission";
import { register as registerRegistrar } from "./registrar";
import { register as registerSessions } from "./sessions";

export const FIXTURES = [registerMission, registerRegistrar, registerSessions] as const;

export type FixtureRegistrar = (router: FixtureRouter, state: HarnessState) => void;
