/** Explicit pins must be acknowledged before either warmup or task prompts. */

interface ModelSession {
  sessionId: string;
  models?: unknown;
  configOptions?: unknown;
}
interface SelectionInput {
  model?: string;
  requestedConfig?: Record<string, string>;
  session: ModelSession;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}
interface SelectionResult {
  mechanism: "config_options" | "models";
  set_model_sent: boolean;
  config_options?: Record<string, string>;
  backend_model_uid: null;
}

export class AcpModelUnavailableError extends Error {
  constructor(readonly advertised: boolean) {
    super("stdio-acp: explicit model is not advertised by this session");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configState(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("stdio-acp: model configOptions must be an array");
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of value as unknown[]) {
    if (
      !record(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      result.has(entry.id)
    ) {
      throw new Error("stdio-acp: model configOptions have missing or duplicate IDs");
    }
    result.set(entry.id, entry);
  }
  return result;
}

function selectValues(options: unknown): string[] {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("stdio-acp: model config option has no select values");
  }
  const entries: unknown[] = options;
  const grouped = record(entries[0]) && "group" in entries[0];
  const values: string[] = [];
  for (const entry of entries) {
    if (!record(entry)) throw new Error("stdio-acp: malformed model config values");
    if (grouped) {
      values.push(...selectGroup(entry));
    } else values.push(selectValue(entry));
  }
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error("stdio-acp: model config values are empty or ambiguous");
  }
  return values;
}

function selectGroup(entry: Record<string, unknown>): string[] {
  if (
    typeof entry.group !== "string" ||
    typeof entry.name !== "string" ||
    !Array.isArray(entry.options)
  ) {
    throw new Error("stdio-acp: malformed model config group");
  }
  return (entry.options as unknown[]).map(selectValue);
}

function selectValue(entry: unknown): string {
  if (
    !record(entry) ||
    "group" in entry ||
    typeof entry.value !== "string" ||
    entry.value.length === 0 ||
    typeof entry.name !== "string"
  ) {
    throw new Error("stdio-acp: malformed model config value");
  }
  return entry.value;
}

function selectedOption(
  state: Map<string, Record<string, unknown>>,
  id: string,
  value: string,
): Record<string, unknown> {
  const option = state.get(id);
  if (option?.type !== "select" || typeof option.currentValue !== "string") {
    throw new Error(`stdio-acp: model config option ${id} is missing or unsupported`);
  }
  const values = selectValues(option.options);
  if (!values.includes(value) || !values.includes(option.currentValue)) {
    throw new Error(`stdio-acp: model config option ${id} does not advertise the requested value`);
  }
  return option;
}

function verifyPins(state: Map<string, Record<string, unknown>>, pins: Map<string, string>): void {
  for (const [id, value] of pins) {
    if (selectedOption(state, id, value).currentValue !== value) {
      throw new Error(`stdio-acp: model config option ${id} was not acknowledged`);
    }
  }
}

function requestedPins(
  input: SelectionInput,
  candidates: Record<string, unknown>[],
): [string, string][] {
  let requested: [string, string][];
  if (input.requestedConfig !== undefined) {
    requested = Object.entries(input.requestedConfig);
    if (
      requested.length === 0 ||
      requested.some(
        ([id, value]) => id.length === 0 || typeof value !== "string" || value.length === 0,
      )
    ) {
      throw new Error("stdio-acp: modelConfigOptions must contain nonempty string pins");
    }
  } else {
    if (candidates.length !== 1 || !input.model)
      throw new Error("stdio-acp: model config selector is missing or ambiguous");
    requested = [[String(candidates[0]?.id), input.model]];
  }
  return requested;
}

async function selectConfig(input: SelectionInput): Promise<SelectionResult> {
  let state = configState(input.session.configOptions);
  const candidates = [...state.values()].filter(
    (option) => option.category === "model" || option.id === "model",
  );
  const requested = requestedPins(input, candidates);
  // Model changes may replace dependent menus; validate each remaining choice only after that ACK.
  const modelId = candidates.length === 1 ? candidates[0]?.id : undefined;
  requested.sort(([left], [right]) => Number(right === modelId) - Number(left === modelId));
  const acknowledged = new Map<string, string>();
  for (const [id, value] of requested) {
    const option = selectedOption(state, id, value);
    if (option.currentValue !== value) {
      const response = await input.request("session/set_config_option", {
        sessionId: input.session.sessionId,
        configId: id,
        value,
      });
      state = configState(record(response) ? response.configOptions : undefined);
    }
    acknowledged.set(id, value);
    verifyPins(state, acknowledged);
  }
  verifyPins(state, new Map(requested));
  return {
    mechanism: "config_options",
    set_model_sent: false,
    config_options: Object.fromEntries(acknowledged),
    backend_model_uid: null,
  };
}

export async function selectAcpSessionModel(input: SelectionInput): Promise<SelectionResult> {
  if (input.session.configOptions !== undefined || input.requestedConfig !== undefined)
    return await selectConfig(input);
  const models = input.session.models;
  if (!record(models) || !Array.isArray(models.availableModels))
    throw new AcpModelUnavailableError(false);
  const listed = (models.availableModels as unknown[]).some(
    (entry) => record(entry) && entry.modelId === input.model,
  );
  if (!listed) throw new AcpModelUnavailableError(true);
  const sent = models.currentModelId !== input.model;
  if (sent) {
    const response = await input.request("session/set_model", {
      sessionId: input.session.sessionId,
      modelId: input.model,
    });
    if (!record(response)) throw new Error("stdio-acp: malformed session/set_model acknowledgment");
  }
  return { mechanism: "models", set_model_sent: sent, backend_model_uid: null };
}
