import { samePath } from "./paths.ts";
import type { DelegationProvider } from "./types.ts";

export const T3_BRIDGE_ENV = "T3_PI_MCP_EXTENSION_PATH";

export const SUBAGENT_TOOL = "subagent";
export const SUBAGENT_LOADER = "subagents_enable";

/** pi-subagentura's fresh-context child tool, and the tools it reads a background child with. */
export const SUBAGENTURA_TOOL = "subagent_isolated";
export const SUBAGENTURA_STATUS_TOOL = "get_subagent_status";
export const SUBAGENTURA_RESULT_TOOL = "get_subagent_result";
/**
 * pi-subagentura's other tools that start a child. pstack never delegates through them, but under a
 * model filter the adapter still checks or blocks them, because each one picks a model.
 */
export const SUBAGENTURA_OTHER_SPAWN_TOOLS = ["subagent_with_context", "subagent_interactive", "workflow"] as const;

/**
 * T3 Code's Pi bridge registers its MCP tools under this public prefix. It also registers a
 * `mcp__t3_code__` copy with hidden exposure to reserve the name, which the model cannot call.
 */
export const T3_TOOL_PREFIX = "mcp__t3-code__";
export const T3_DELEGATE_TOOL = `${T3_TOOL_PREFIX}delegate_task`;
export const T3_STATUS_TOOL = `${T3_TOOL_PREFIX}task_status`;
export const T3_CAPABILITIES_TOOL = `${T3_TOOL_PREFIX}orchestrator_capabilities`;

export interface DelegationBackend {
  readonly id: DelegationProvider;
  readonly label: string;
  readonly tool: string;
  readonly companions: readonly string[];
  readonly requiredParameters: readonly string[];
}

export const DELEGATION_BACKENDS: Readonly<Record<DelegationProvider, DelegationBackend>> = {
  "t3": {
    id: "t3",
    label: "T3 Code",
    tool: T3_DELEGATE_TOOL,
    companions: [T3_CAPABILITIES_TOOL, T3_STATUS_TOOL],
    requiredParameters: ["task", "target", "mode"],
  },
  "pi-subagents": {
    id: "pi-subagents",
    label: "pi-subagents",
    tool: SUBAGENT_TOOL,
    companions: [],
    requiredParameters: ["agent", "task", "async", "model"],
  },
  "subagentura": {
    id: "subagentura",
    label: "pi-subagentura",
    tool: SUBAGENTURA_TOOL,
    companions: [SUBAGENTURA_STATUS_TOOL, SUBAGENTURA_RESULT_TOOL],
    requiredParameters: ["task", "model", "thinkingLevel", "async"],
  },
};

export const DELEGATION_PROVIDERS: readonly DelegationProvider[] = ["t3", "pi-subagents", "subagentura"];
export const DEFAULT_DELEGATION: DelegationProvider = "t3";

export function isDelegationProvider(value: unknown): value is DelegationProvider {
  return typeof value === "string" && (DELEGATION_PROVIDERS as readonly string[]).includes(value);
}

export function delegationOrder(preferred: DelegationProvider): readonly DelegationBackend[] {
  return [preferred, ...DELEGATION_PROVIDERS.filter((id) => id !== preferred)].map((id) => DELEGATION_BACKENDS[id]);
}

export interface ToolPresence {
  readonly name: string;
  readonly exposure?: string;
  readonly parameters?: unknown;
  readonly sourceInfo?: { readonly source?: string; readonly path?: string };
}

export function callableTool<T extends ToolPresence>(tools: readonly T[], name: string): T | undefined {
  return tools.find((tool) => tool.name === name && tool.exposure !== "hidden");
}

export interface DelegationHost {
  readonly t3BridgePath?: string;
  readonly platform?: NodeJS.Platform;
}

export function delegationHost(env: NodeJS.ProcessEnv = process.env): DelegationHost {
  return { t3BridgePath: env[T3_BRIDGE_ENV] || undefined, platform: process.platform };
}

export type DelegationResolution =
  | {
      readonly kind: "resolved";
      readonly backend: DelegationBackend;
      readonly tool: ToolPresence;
      readonly companions: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly problems: readonly string[] };

export function resolveDelegation(
  tools: readonly ToolPresence[],
  preferred: DelegationProvider,
  host: DelegationHost,
): DelegationResolution {
  const problems: string[] = [];
  for (const backend of delegationOrder(preferred)) {
    const tool = callableTool(tools, backend.tool);
    if (!tool) continue;
    if (backend.id === "t3" && !fromT3Bridge(tool, host)) {
      problems.push(
        `The \`${backend.tool}\` tool was not registered by T3 Code's bridge, so the adapter ignores it. T3 Code sets ${T3_BRIDGE_ENV} to the bridge it launches.`,
      );
      continue;
    }
    const properties = parameterNames(tool.parameters);
    const missing = backend.requiredParameters.filter((name) => !properties.has(name));
    if (missing.length > 0) {
      problems.push(`The \`${backend.tool}\` tool is present but does not accept ${missing.join(", ")}.`);
      continue;
    }
    const companions = backend.companions.filter((name) => {
      const companion = callableTool(tools, name);
      if (companion === undefined) return false;
      if (backend.id === "t3") return fromT3Bridge(companion, host);
      if (backend.id === "subagentura") return sameOwner(companion, tool, host);
      return true;
    });
    return { kind: "resolved", backend, tool, companions };
  }
  return { kind: "unavailable", problems };
}

/** A companion counts only when the extension that registered the delegation tool registered it too. */
function sameOwner(companion: ToolPresence, tool: ToolPresence, host: DelegationHost): boolean {
  const a = companion.sourceInfo?.path;
  const b = tool.sourceInfo?.path;
  if (!a || !b) return false;
  return samePath(a, b, host.platform ?? process.platform);
}

function fromT3Bridge(tool: ToolPresence, host: DelegationHost): boolean {
  const owner = tool.sourceInfo?.path;
  if (!host.t3BridgePath || !owner) return false;
  const platform = host.platform ?? process.platform;
  return samePath(owner, host.t3BridgePath, platform);
}

export function parameterNames(parameters: unknown): Set<string> {
  if (typeof parameters !== "object" || parameters === null) return new Set();
  const properties = (parameters as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return new Set();
  return new Set(Object.keys(properties as Record<string, unknown>));
}
