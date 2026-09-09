import { Link } from "react-router-dom";

import { MODULES, type ModuleSpec } from "@src/modules/manifest";

export type EntityKind = "handoff" | "task" | "conversation" | "lane";

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
  const module = moduleId ? modules.find((m) => m.id === moduleId) : undefined;
  const copyLabel = `Copy ${kind} id ${id}`;

  if (module?.available) {
    return (
      <Link className="entity-link entity-link-linked" to={`${module.path}/${id}`}>
        <code className="entity-link-id">{id}</code>
      </Link>
    );
  }

  return (
    <span className="entity-link entity-link-unlinked">
      <code className="entity-link-id">{id}</code>{" "}
      <button
        aria-label={copyLabel}
        className="btn btn-ghost entity-link-copy"
        type="button"
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(id);
          }
        }}
      >
        Copy
      </button>
    </span>
  );
}
