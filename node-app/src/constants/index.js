/**
 * chatbot-voice — central configuration.
 *
 * Transport: WebRTC. The BROWSER connects directly to the OpenAI Realtime API
 * over an RTCPeerConnection (audio over a media track, events over a data
 * channel). The BACKEND only (a) mints a short-lived ephemeral token so the
 * real API key never reaches the browser, and (b) executes tool calls against
 * the Byit backend. There is no realtime WebSocket anymore.
 *
 * This feature stays ISOLATED from the text chatbot: its own port, its own
 * routes, its own OpenAI credential. It reuses the existing Byit tools
 * (services/tools.js) read-only — never the chatbot's Express app or state.
 */

// ── OpenAI Realtime API (WebRTC) ───────────────────────────────────────────
// `OPENAI_API_KEY` in this repo actually holds a GOOGLE/Gemini key (it's passed
// to GeminiModel in chatbot-backend), so we deliberately do NOT reuse it — the
// real OpenAI Realtime key lives in OPENAI_REALTIME_API_KEY.
export const OPENAI_REALTIME_API_KEY =
  process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_REALTIME_KEY || "";

export const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

// REST endpoint (backend) — mints the ephemeral client token.
export const OPENAI_CLIENT_SECRETS_URL =
  process.env.OPENAI_CLIENT_SECRETS_URL ||
  "https://api.openai.com/v1/realtime/client_secrets";

// SDP exchange endpoint (browser) — the offer/answer call. Exposed to the
// client via /session so the front end never hard-codes an OpenAI URL.
export const OPENAI_REALTIME_CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ||
  "https://api.openai.com/v1/realtime/calls";

// WebRTC data-channel label OpenAI expects for the event stream.
export const REALTIME_DATA_CHANNEL = "oai-events";

// Voice used for the spoken response. OpenAI voices: alloy, ash, ballad,
// coral, echo, sage, shimmer, verse.
export const REALTIME_VOICE = process.env.REALTIME_VOICE || "alloy";

// Spoken playback speed multiplier (OpenAI Realtime audio.output.speed).
// 1.0 = normal; >1 is faster. Range ~0.25–1.5. Default 1.4 for a brisk pace.
export const REALTIME_SPEED = parseFloat(process.env.REALTIME_SPEED || "1.5");

// Transcription model for the user's spoken input (shown in history). With
// WebRTC the audio itself is negotiated as Opus via SDP — no PCM format/sample
// rate config is needed on either side.
export const TRANSCRIBE_MODEL =
  process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-4o-transcribe";

export const TRANSCRIBE_LANGUAGE =
  process.env.TRANSCRIBE_LANGUAGE ?? "ar"; // "" disables the hint (auto-detect)

// IMPORTANT: keep this free of domain phrases (property types, areas, prices).
// gpt-4o-transcribe treats `prompt` as a continuation seed — on a silent/noisy
// turn it parrots the prompt's own vocabulary, fabricating fluent fake requests
// (e.g. "محتاج شقة في مدينتي بحوالي تلت مليون"). The prompt is now limited to a
// script hint (write Arabic in Arabic letters), which can't be parroted into a
// fake real-estate request. Numbers/areas accuracy should come from the model's
// instructions + conversation context, not from biasing the transcriber.
export const TRANSCRIBE_PROMPT = "اكتب الكلام العربي بالحروف العربية، مش بحروف لاتينية.";

// ── Conversation finite-state machine ───────────────────────────────────────
// Push-to-talk, NOT a live call:
//   IDLE → RECORDING → PROCESSING → PLAYING → IDLE
// ERROR can be entered from any state and resolves back to IDLE.
export const VOICE_STATE = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  PROCESSING: "processing",
  PLAYING: "playing",
  ERROR: "error",
});

// ── Realtime data-channel event names (GA /v1/realtime) ─────────────────────
// Documented here as the single source of truth shared by the browser client.
export const REALTIME_EVENTS = Object.freeze({
  // client → OpenAI
  SESSION_UPDATE: "session.update",
  INPUT_AUDIO_COMMIT: "input_audio_buffer.commit",
  INPUT_AUDIO_CLEAR: "input_audio_buffer.clear",
  RESPONSE_CREATE: "response.create",
  CONVERSATION_ITEM_CREATE: "conversation.item.create",
  // OpenAI → client
  SESSION_UPDATED: "session.updated",
  USER_TRANSCRIPT_DONE: "conversation.item.input_audio_transcription.completed",
  ASSISTANT_TRANSCRIPT_DELTA: "response.output_audio_transcript.delta",
  ASSISTANT_TRANSCRIPT_DONE: "response.output_audio_transcript.done",
  FUNCTION_CALL_DONE: "response.function_call_arguments.done",
  RESPONSE_DONE: "response.done",
  ERROR: "error",
});

// ── Byit / business context ─────────────────────────────────────────────────
// chatbot-voice is EGYPT ONLY. UAE (country 7) is intentionally not supported
// here — the country is fixed to Egypt (50) regardless of request headers or
// query params. (The text chatbot still supports both; this is voice-only.)
export const EGYPT_COUNTRY = 50;
export const DEFAULT_COUNTRY = EGYPT_COUNTRY;

// Standalone listen port (only used when this module is run directly).
export const VOICE_PORT = parseInt(process.env.VOICE_PORT || "3100", 10);

// ── Optional TLS ────────────────────────────────────────────────────────────
// Microphone / WebRTC require a SECURE context: https:// or http://localhost.
// On the same machine, plain http://localhost works. To reach the page from
// another device (a phone), serve HTTPS by pointing these at a cert + key:
//   VOICE_TLS_CERT_FILE=./cert.pem VOICE_TLS_KEY_FILE=./key.pem npm run voice
// (generate a dev cert with:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost")
// Leave unset to serve plain http.
export const VOICE_TLS_CERT_FILE = process.env.VOICE_TLS_CERT_FILE || "";
export const VOICE_TLS_KEY_FILE = process.env.VOICE_TLS_KEY_FILE || "";

// Route prefix when mounted into the unified server (see README).
export const VOICE_ROUTE_PREFIX = "/voice";

// ── Backend memory / context manager ───────────────────────────────────────
// The voice agent's long-conversation stability comes from a BACKEND memory
// layer (see services/context-manager.service.js): structured user preferences,
// an auto-generated conversation summary, and a turn/token budget that decides
// when the browser should silently re-mint its Realtime session. None of this
// touches the WebRTC handshake — memory + summary ride inside the session
// instructions baked into each ephemeral token.

// Cheap text model used for preference EXTRACTION + conversation SUMMARIES.
// Runs off the audio path (called when a finished transcript is reported), so a
// small/fast model is the right trade-off. Reuses OPENAI_REALTIME_API_KEY.
export const MEMORY_LLM_MODEL = process.env.MEMORY_LLM_MODEL || "gpt-4o-mini";

// Standard OpenAI Chat Completions endpoint (NOT the Realtime endpoint).
export const OPENAI_CHAT_COMPLETIONS_URL =
  process.env.OPENAI_CHAT_COMPLETIONS_URL ||
  "https://api.openai.com/v1/chat/completions";

// Master switch for the LLM-backed extractor/summarizer. When false (or the key
// is missing) the context manager degrades to a deterministic fallback
// (language + budget heuristics) and never makes a network call.
export const MEMORY_LLM_ENABLED =
  (process.env.MEMORY_LLM_ENABLED ?? "true").toLowerCase() !== "false";

// Hard timeout (ms) for any extraction/summary call so a slow model can never
// stall the /history response the browser waits on for its refresh decision.
export const MEMORY_LLM_TIMEOUT_MS = parseInt(
  process.env.MEMORY_LLM_TIMEOUT_MS || "8000",
  10
);

// User turns since the last refresh before we re-mint the Realtime session.
// (Spec example: "20 turns". Voice audio tokens are heavy, so the default is a
// little lower; tune via env without code changes.)
export const CONTEXT_MAX_TURNS = parseInt(
  process.env.CONTEXT_MAX_TURNS || "16",
  10
);

// Approx. context window (tokens) of the Realtime model, used only to derive a
// usage PERCENT for the "> 70%" refresh trigger. This is an estimate — audio
// tokens are invisible to us — so it is a safety net behind CONTEXT_MAX_TURNS.
export const CONTEXT_TOKEN_WINDOW = parseInt(
  process.env.CONTEXT_TOKEN_WINDOW || "32000",
  10
);

// Refresh when estimated usage crosses this fraction of the window.
export const CONTEXT_TOKEN_THRESHOLD = parseFloat(
  process.env.CONTEXT_TOKEN_THRESHOLD || "0.7"
);

// Rough per-turn audio-token overhead (input speech + spoken answer) added to
// the text estimate so the usage figure reflects real Realtime growth.
export const CONTEXT_AUDIO_TOKENS_PER_TURN = parseInt(
  process.env.CONTEXT_AUDIO_TOKENS_PER_TURN || "500",
  10
);

// How many recent turns to replay into a freshly minted session's instructions
// so the conversation resumes naturally after a silent refresh.
export const CONTEXT_RECENT_MESSAGES = parseInt(
  process.env.CONTEXT_RECENT_MESSAGES || "6",
  10
);

// Don't bother summarizing until the conversation has at least this many turns.
export const CONTEXT_SUMMARY_MIN_MESSAGES = parseInt(
  process.env.CONTEXT_SUMMARY_MIN_MESSAGES || "4",
  10
);

// Persistent LONG-TERM user memory (see store/memory.repository.js) is keyed by
// userId and survives sessions, reconnects, and browser refreshes. The default
// backend is an in-memory map snapshotted to this JSON file so it ALSO survives
// a server restart. Set to "" to disable file persistence (pure in-memory), or
// point it at a writable path. Swap the backend entirely for Redis/Mongo
// without touching callers (the repository exposes a tiny get/set/delete seam).
export const USER_MEMORY_FILE =
  process.env.USER_MEMORY_FILE ?? "./.user-memory.json";

// The structured user-preference fields the memory layer tracks. Single source
// of truth shared by the store, the extractor, and the prompt builder.
export const MEMORY_FIELDS = Object.freeze([
  "area",
  "budget",
  "unitType",
  "category",
  "preferredDeveloper",
  "paymentPreference",
  "language",
]);
