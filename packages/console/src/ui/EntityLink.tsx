import { Link } from "react-router-dom";

import { MODULES, type ModuleSpec } from "@src/modules/manifest";

type EntityKind = "handoff" | "task" | "conversation" | "lane";

const MODULE_FOR_KIND: Record<EntityKind, string | undefined> = {
  conversation: "chains",
  handoff: "handoffs",
  lane: undefined,
  task: "tasks",
};

export interface EntityLinkProps {
  id: string;
  kind: EntityKind;
  modules?: readonly ModuleSpec[];
}

export function EntityLink(props: EntityLinkProps): JSX.Element {
  const { id, kind, modules = MODULES } = props;
  const moduleId = MODULE_FOR_KIND[kind];
  const module = moduleId ? (modules ?? MODULES).find((m) => m.id === moduleId) : undefined;

  if (module?.available) {
    return (
      <Link to={`${module.path}/${id}`}>
        <code>{id}</code>
      </Link>
    );
  }

  return (
    <>
      <code>{id}</code>
      <button
        aria-label="Copy id"
        type="button"
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(id);
          }
        }}
      >
        Copy
      </button>
    </>
  );
}
