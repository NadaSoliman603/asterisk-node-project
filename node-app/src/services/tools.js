/**
 * chatbot-voice — tool-calling bridge.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TOOL CALLING LOGIC                                                        │
 * │ The OpenAI Realtime model decides WHEN to call a tool; this module owns   │
 * │ the WHAT and HOW. It:                                                      │
 * │   1. Builds OpenAI "function" tool definitions from the EXISTING Byit     │
 * │      Strands tools (single source of truth — same schemas as the text     │
 * │      chatbot, no duplication).                                            │
 * │   2. Executes a tool call by invoking that same tool's callback, which    │
 * │      hits the real Byit backend (services/api.js → cache.js).             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A Strands tool object (from `tool({...})`) exposes:
 *   .name        tool name
 *   .toolSpec    { name, description, inputSchema }  ← already JSON-Schema shaped
 *   ._callback   async (args) => string              ← the real implementation
 *
 * OpenAI Realtime wants tools shaped as:
 *   { type: "function", name, description, parameters: <JSON Schema> }
 * …so `toolSpec` maps over almost verbatim.
 *
 * @typedef {import('../types/index.js').ToolCallRequest}  ToolCallRequest
 * @typedef {import('../types/index.js').ToolCallResponse} ToolCallResponse
 */

import {
  createSearchProperties,
  createGetDevelopers,
  createCalculateCommission,
  createRequestUnitSelection,
  createGetProjectsByDeveloper,
} from "../backend/tools/index.js";
import { clearRawForSession } from "./api.js";
import { formatToolOutput } from "./tool-formatter.js";
import { logger, safeJsonParse } from "../utils/index.js";

const log = logger("tools");

/**
 * Build the country-scoped tool set for one session. Country and sessionId are
 * baked into the closures here — exactly how chatbot-backend/server.js builds
 * its agent — so the model's arguments never need to carry them.
 *
 * @param {number} country  Byit country id (50 = Egypt, 7 = UAE)
 * @param {string} sessionId
 * @returns {{ definitions: object[], registry: Map<string, Function> }}
 *   `definitions` → pass to OpenAI in session.update.tools
 *   `registry`    → name → callback, used by handleToolCall()
 */
export function buildToolset(country, sessionId) {
  const tools = [
    createSearchProperties(country, sessionId),
    createGetDevelopers(country),
    createCalculateCommission(country),
    createRequestUnitSelection(country),
    createGetProjectsByDeveloper(country),
  ];

  const definitions = tools.map(toOpenAIToolDefinition);

  /** @type {Map<string, Function>} */
  const registry = new Map();
  for (const t of tools) registry.set(t.name, t._callback);

  log.info(
    `built ${tools.length} tools for country=${country}:`,
    tools.map((t) => t.name).join(", ")
  );
  return { definitions, registry };
}

/**
 * Convert one Strands tool → an OpenAI Realtime "function" tool definition.
 * @param {{toolSpec: {name: string, description: string, inputSchema: object}}} tool
 */
export function toOpenAIToolDefinition(tool) {
  const spec = tool.toolSpec || {};
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema || { type: "object", properties: {} },
  };
}

/**
 * Execute a single tool call coming from the model.
 *
 * @param {ToolCallRequest} call
 * @param {Map<string, Function>} registry  from buildToolset()
 * @returns {Promise<ToolCallResponse>}
 */
export async function handleToolCall(call, registry) {
  const { callId, name, arguments: args } = call;
  const fn = registry.get(name);

  if (!fn) {
    log.warn(`no handler for tool "${name}"`);
    return {
      callId,
      name,
      ok: false,
      error: `unknown_tool:${name}`,
      output: JSON.stringify({ error: `Unknown tool: ${name}` }),
    };
  }

  const started = Date.now();
  try {
    let output = await executeBackendRequest(fn, args);

    // ── Developer resolution hard gate ────────────────────────────────────
    // When the model called get_developers to resolve a SPECIFIC developer
    // name (args.name is non-empty) and no match came back, we short-circuit
    // here in code — no further tool calls are possible because the model
    // receives a found=false response it must surface verbatim and stop.
    if (name === "get_developers" && args.name && args.name.trim()) {
      const parsed = safeJsonParse(output, {});
      const devs = Array.isArray(parsed.developers) ? parsed.developers : [];
      if (devs.length === 0) {
        log.info(`get_developers: no match for "${args.name}" — hard-stop gate triggered`);
        return {
          callId,
          name,
          ok: true,
          output: JSON.stringify({
            found: false,
            error: "developer_not_found",
            developer_name: args.name,
            message:
              "المطور ده يا إما مش معانا في المعرض، أو ممكن أكون مش سامعك بوضوح. ممكن تقولي اسم المطور تاني؟",
          }),
        };
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    if (name === "search_properties") output = deduplicateDevelopers(output);
    // Trim heavy tool payloads to only what the voice agent may use, so long
    // conversations don't accumulate giant raw API responses in model context.
    output = formatToolOutput(name, output);
    log.info(`${name} ok — ${Date.now() - started}ms`);
    return { callId, name, ok: true, output };
  } catch (e) {
    log.error(`${name} FAILED after ${Date.now() - started}ms:`, String(e));
    return {
      callId,
      name,
      ok: false,
      error: String(e),
      // Always hand the model a JSON string so the turn can continue.
      output: JSON.stringify({ error: "tool_execution_failed", detail: String(e) }),
    };
  }
}

/**
 * Run the underlying tool callback against the real backend.
 * Kept as its own function so it's the obvious seam for retries / metrics /
 * auth headers later, and so handleToolCall stays about orchestration.
 *
 * @param {Function} fn    a Strands tool `_callback`
 * @param {Record<string, any>} args
 * @returns {Promise<string>}  the model-facing JSON string the tool returns
 */
export async function executeBackendRequest(fn, args) {
  // Strands tool callbacks return a string (usually JSON). Normalize to string.
  const result = await fn(args || {});
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * Remove duplicate company entries from a search_properties JSON output so the
 * AI model never receives the same developer name more than once.
 * Deduplicates by company.id when present, falls back to normalized name.
 * Duplicate entries have their company field removed, not the property itself.
 */
function deduplicateDevelopers(jsonStr) {
  try {
    const data = safeJsonParse(jsonStr, null);
    if (!data || !Array.isArray(data.properties)) return jsonStr;

    const seen = new Set();
    for (const prop of data.properties) {
      const c = prop.company;
      if (!c) continue;
      const key =
        c.id != null
          ? `id:${c.id}`
          : `name:${(c.name_en || c.name || "").trim().toLowerCase()}`;
      if (seen.has(key)) {
        delete prop.company;
      } else {
        seen.add(key);
      }
    }
    return JSON.stringify(data);
  } catch {
    return jsonStr;
  }
}

/**
 * Parse a raw OpenAI function_call_arguments payload into a ToolCallRequest.
 * @param {{call_id: string, name: string, arguments: string}} raw
 * @returns {ToolCallRequest}
 */
export function parseToolCall(raw) {
  return {
    callId: raw.call_id,
    name: raw.name,
    arguments: safeJsonParse(raw.arguments, {}),
  };
}

export { clearRawForSession };
