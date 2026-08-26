export interface CarrierModelVars {
  readonly modelId: string;
  readonly reasoningTier?: string;
  readonly displayName?: string;
}

export interface BindingCarriers {
  readonly binary?: string;
  readonly args_template?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly unset_env?: readonly string[];
  readonly mcp_servers?: unknown;
  readonly authMethodId?: string;
  readonly subscription_model_source?: "modelId" | "displayName";
}

export interface AppliedCarriers {
  options: Record<string, unknown>;
  topLevel: Record<string, unknown>;
  managedFields: string[];
}

export interface RenderTemplateTokenOptions {
  readonly onMissingTier?: "throw" | "empty";
}

export function renderTemplateTokens(
  tokens: readonly string[],
  vars: CarrierModelVars,
  opts: RenderTemplateTokenOptions = {},
): string[] {
  return tokens.map((token) => renderTemplateToken(token, vars, opts));
}

function renderTemplateToken(
  token: string,
  vars: CarrierModelVars,
  opts: RenderTemplateTokenOptions = {},
): string {
  if (
    (opts.onMissingTier ?? "throw") === "throw" &&
    token.includes("{tier}") &&
    vars.reasoningTier === undefined
  ) {
    throw new Error("reasoningTier is required for carrier template token {tier}");
  }
  const rendered = token
    .replaceAll("{model}", vars.modelId)
    .replaceAll("{tier}", vars.reasoningTier ?? "")
    .replaceAll("{displayName}", vars.displayName ?? "");
  const leftoverPlaceholder = rendered.match(/\{[a-zA-Z_]+\}/)?.[0];
  if (leftoverPlaceholder !== undefined) {
    throw new Error(
      `carrier template token ${JSON.stringify(token)} rendered unknown placeholder ${leftoverPlaceholder}`,
    );
  }
  return rendered;
}

function binaryOptionPath(kind: string): string {
  switch (kind) {
    case "stdio-acp":
      return "binary";
    case "opencode-acp":
      return "opencodeBinary";
    case "agy-cli":
    case "cli":
      return "command";
    default:
      throw new Error(`carriers.binary is not supported for binding kind ${JSON.stringify(kind)}`);
  }
}

export function applyBindingCarriers(
  baseOptions: Record<string, unknown>,
  carriers: BindingCarriers | undefined,
  kind: string,
  vars: CarrierModelVars,
): AppliedCarriers {
  if (carriers === undefined) {
    return { options: baseOptions, topLevel: {}, managedFields: [] };
  }

  const options: Record<string, unknown> = { ...baseOptions };
  const topLevel: Record<string, unknown> = {};
  const managedFields: string[] = [];

  if (carriers.binary !== undefined) {
    const path = binaryOptionPath(kind);
    options[path] = renderTemplateToken(carriers.binary, vars);
    managedFields.push(`options.${path}`);
  }

  if (carriers.args_template !== undefined) {
    options.args = renderTemplateTokens(carriers.args_template, vars);
    managedFields.push("options.args");
  }

  if (carriers.env !== undefined) {
    const renderedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(carriers.env)) {
      renderedEnv[key] = renderTemplateToken(value, vars);
    }
    options.env = renderedEnv;
    managedFields.push("options.env");
  }

  if (carriers.unset_env !== undefined) {
    options.unsetEnv = [...carriers.unset_env];
    managedFields.push("options.unsetEnv");
  }

  if (carriers.mcp_servers !== undefined) {
    options.mcpServers = carriers.mcp_servers;
    managedFields.push("options.mcpServers");
  }

  if (carriers.authMethodId !== undefined) {
    options.authMethodId = carriers.authMethodId;
    managedFields.push("options.authMethodId");
  }

  if (carriers.subscription_model_source !== undefined) {
    if (carriers.subscription_model_source === "displayName" && vars.displayName === undefined) {
      throw new Error("displayName is required for subscription_model_source displayName");
    }
    topLevel.subscription_model =
      carriers.subscription_model_source === "modelId" ? vars.modelId : vars.displayName;
    managedFields.push("subscription_model");
  }

  return { options, topLevel, managedFields };
}
