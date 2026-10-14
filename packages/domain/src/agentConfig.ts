/** Provider-neutral configuration preserved at the time an agent run is queued. */
export const MAX_AGENT_CONFIG_BYTES = 32 * 1024;
export const MAX_AGENT_CONFIG_DEPTH = 20;
export const MAX_AGENT_CONFIG_NODES = 4096;

export type AgentConfigIssue =
  | "invalid_type"
  | "invalid_json"
  | "object_required"
  | "unsupported_version"
  | "invalid_field"
  | "too_large"
  | "too_deep"
  | "too_complex"
  | "non_finite_number";

const messages: Readonly<Record<AgentConfigIssue, string>> = {
  invalid_type: "Agent configuration must be a JSON string",
  invalid_json: "Agent configuration is not valid JSON",
  object_required: "Agent configuration must contain a JSON object",
  unsupported_version: "Agent configuration version is not supported",
  invalid_field: "Agent configuration contains an invalid known field",
  too_large: "Agent configuration exceeds the UTF-8 size limit",
  too_deep: "Agent configuration exceeds the nesting limit",
  too_complex: "Agent configuration exceeds the value-count limit",
  non_finite_number: "Agent configuration contains a non-finite number",
};

/** Diagnostics deliberately exclude configuration values and property names. */
export class AgentConfigError extends Error {
  readonly code: AgentConfigIssue;

  constructor(code: AgentConfigIssue) {
    super(messages[code]);
    this.name = "AgentConfigError";
    this.code = code;
  }
}

// The domain package cannot depend on TextEncoder, Buffer or a particular host.
// A lone surrogate occupies three bytes when encoded with UTF-8 replacement.
function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Validate new subscription input and return stable, key-sorted JSON.
 * Unknown keys are retained: this is a bounded configuration document, not a
 * schema for any particular provider. It never becomes executable CLI flags.
 */
export function normalizeAgentConfig(config?: string): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config !== "string") throw new AgentConfigError("invalid_type");
  if (utf8Length(config) > MAX_AGENT_CONFIG_BYTES) throw new AgentConfigError("too_large");
  if (config.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new AgentConfigError("invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentConfigError("object_required");
  }
  const fields = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(fields, "version") && fields.version !== 1) {
    throw new AgentConfigError("unsupported_version");
  }
  if (
    (Object.prototype.hasOwnProperty.call(fields, "instructions") && typeof fields.instructions !== "string") ||
    (Object.prototype.hasOwnProperty.call(fields, "language") &&
      (typeof fields.language !== "string" || fields.language.trim() === "" || fields.language.length > 80)) ||
    (Object.prototype.hasOwnProperty.call(fields, "maxCommentChars") &&
      (typeof fields.maxCommentChars !== "number" ||
        !Number.isInteger(fields.maxCommentChars) ||
        fields.maxCommentChars < 1 ||
        fields.maxCommentChars > 16000))
  ) {
    throw new AgentConfigError("invalid_field");
  }

  let nodes = 0;
  function serialize(value: unknown, depth: number): string {
    if (depth > MAX_AGENT_CONFIG_DEPTH) throw new AgentConfigError("too_deep");
    if (++nodes > MAX_AGENT_CONFIG_NODES) throw new AgentConfigError("too_complex");
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new AgentConfigError("non_finite_number");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map((item) => serialize(item, depth + 1)).join(",")}]`;
    const object = value as Record<string, unknown>;
    // Construct JSON directly rather than assigning keys to a new object;
    // __proto__ and constructor remain ordinary data, without prototype writes.
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(object[key], depth + 1)}`)
      .join(",")}}`;
  }

  const normalized = serialize(parsed, 0);
  // JSON.stringify expands lone surrogates to escapes, so check both the raw
  // document and its canonical representation before persisting a snapshot.
  if (utf8Length(normalized) > MAX_AGENT_CONFIG_BYTES) throw new AgentConfigError("too_large");
  return normalized;
}

/** Legacy invalid rows use defaults; callers may log the content-free issue. */
export function readStoredAgentConfig(config?: string): Readonly<{
  configSnapshot: string | undefined;
  issue: AgentConfigIssue | undefined;
}> {
  try {
    return Object.freeze({ configSnapshot: normalizeAgentConfig(config), issue: undefined });
  } catch (error) {
    if (!(error instanceof AgentConfigError)) throw error;
    return Object.freeze({ configSnapshot: undefined, issue: error.code });
  }
}
