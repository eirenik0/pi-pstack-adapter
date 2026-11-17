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
 * pi-subagentura's pane mode: a child as its own Pi process in a terminal multiplexer pane (Herdr,
 * tmux, Zellij, or Rex), and the tools that read it. Offered only when the session runs in one.
 */
export const SUBAGENTURA_PANE_TOOL = "subagent_interactive";
export const SUBAGENTURA_ARTIFACT_TOOL = "read_subagent_artifact";
export const SUBAGENTURA_PANE_STATUS_TOOL = "get_interactive_subagent_status";
export const SUBAGENTURA_PANE_TOOLS = [SUBAGENTURA_PANE_TOOL, SUBAGENTURA_ARTIFACT_TOOL, SUBAGENTURA_PANE_STATUS_TOOL] as const;
/** Parameters the pane tool must accept for pane mode to be offered. */
export const SUBAGENTURA_PANE_PARAMETERS = ["task", "model", "thinkingLevel", "cwd", "includeContext", "completionPolicy"] as const;
/**
 * pi-subagentura's other tools that start a child. pstack never delegates through them, but under a
 * model filter the adapter still checks or blocks them, because each one picks a model.
 */
export const SUBAGENTURA_OTHER_SPAWN_TOOLS = ["subagent_with_context", "workflow"] as const;

export type Multiplexer = "herdr" | "tmux" | "zellij" | "rex";

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
  /** The terminal multiplexer this session runs in, which pi-subagentura's pane mode needs. */
  readonly multiplexer?: Multiplexer;
}

export function delegationHost(env: NodeJS.ProcessEnv = process.env): DelegationHost {
  const multiplexer = multiplexerOf(env);
  return { t3BridgePath: env[T3_BRIDGE_ENV] || undefined, platform: process.platform, ...(multiplexer ? { multiplexer } : {}) };
}

/**
 * The multiplexer the environment names, Herdr first because it can run inside tmux. This is a hint
 * for offering pane mode, not proof of ownership: pi-subagentura verifies the pane itself and fails
 * closed, and the host mapping then falls back to \`subagent_isolated\`.
 */
export function multiplexerOf(env: NodeJS.ProcessEnv): Multiplexer | undefined {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.REX_SESSION && env.REX_BLOCK && env.REX_SERVER) return "rex";
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ || env.ZELLIJ_SESSION_NAME) return "zellij";
  return undefined;
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
    if (backend.id === "subagentura") companions.push(...paneTools(tools, tool, host));
    return { kind: "resolved", backend, tool, companions };
  }
  return { kind: "unavailable", problems };
}

/**
 * Pane mode is offered only inside a multiplexer, and only when the same extension registered every
 * pane tool and the launch tool accepts the parameters the host mapping tells the parent to pass.
 */
function paneTools(tools: readonly ToolPresence[], owner: ToolPresence, host: DelegationHost): string[] {
  if (!host.multiplexer) return [];
  const found = SUBAGENTURA_PANE_TOOLS.map((name) => callableTool(tools, name));
  if (found.some((tool) => tool === undefined || !sameOwner(tool, owner, host))) return [];
  const launch = parameterNames(found[0]?.parameters);
  if (SUBAGENTURA_PANE_PARAMETERS.some((name) => !launch.has(name))) return [];
  return [...SUBAGENTURA_PANE_TOOLS];
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
