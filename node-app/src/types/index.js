/**
 * chatbot-voice — type definitions.
 *
 * The repo is plain ESM JavaScript (`"type": "module"`, no TypeScript build
 * step), so the requested TypeScript interfaces are expressed here as JSDoc
 * `@typedef`s. These give the exact same editor IntelliSense / type-checking
 * (via `// @ts-check` or a tsconfig with `checkJs`) without introducing a
 * compiler the rest of the codebase doesn't use.
 *
 * Importing this file for its side effects (none) or referencing the typedefs
 * with `@type {import('../types/index.js').VoiceMessage}` both work.
 *
 * Requested interfaces, one-to-one:
 *   VoiceMessage · ConversationState · RealtimeSession · ToolCallRequest
 *   ToolCallResponse · AudioChunk · BackendSearchRequest · BackendSearchResponse
 */

/**
 * A single turn in the conversation history (user OR assistant).
 * @typedef {Object} VoiceMessage
 * @property {string} id                       Unique message id.
 * @property {"user"|"assistant"} role         Who produced the turn.
 * @property {string} text                     Transcript text (spoken → text).
 * @property {number} createdAt                Epoch ms when the turn was finalized.
 * @property {ToolCallRequest[]} [toolCalls]   Tool calls made while producing this turn.
 *
 * (With WebRTC the spoken audio plays via the remote media track, so we no
 * longer persist base64 audio chunks per message.)
 */

/**
 * The full state of one voice session, kept per sessionId.
 * @typedef {Object} ConversationState
 * @property {string} sessionId
 * @property {number} country                  Byit country id (50 = Egypt, 7 = UAE).
 * @property {import('../constants/index.js').VOICE_STATE[keyof import('../constants/index.js').VOICE_STATE]} state
 * @property {VoiceMessage[]} messages         Ordered history (oldest → newest).
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * A short-lived OpenAI Realtime credential minted server-side. The browser
 * uses `clientSecret` (an `ek_...` token) to perform the WebRTC SDP exchange,
 * so the real API key never leaves the backend.
 * @typedef {Object} EphemeralSession
 * @property {string} sessionId
 * @property {number} country
 * @property {string} clientSecret             Ephemeral `ek_...` token.
 * @property {number} expiresAt                Epoch seconds.
 * @property {string} model
 * @property {string} callsUrl                 OpenAI SDP-exchange endpoint.
 */

/**
 * The browser-side WebRTC connection to OpenAI Realtime.
 * @typedef {Object} WebRTCConnection
 * @property {RTCPeerConnection} pc            Peer connection (audio + data).
 * @property {RTCDataChannel} dataChannel      "oai-events" — realtime events.
 * @property {MediaStream} localStream         Microphone capture.
 * @property {HTMLAudioElement} remoteAudioEl  Plays the assistant's speech.
 * @property {RTCPeerConnectionState} state
 */

/**
 * A function/tool call requested by the model.
 * @typedef {Object} ToolCallRequest
 * @property {string} callId                   OpenAI call id — echoed back in the output.
 * @property {string} name                     Tool name, e.g. "search_properties".
 * @property {Record<string, any>} arguments   Parsed JSON arguments.
 */

/**
 * The result of executing a tool, sent back to the model.
 * @typedef {Object} ToolCallResponse
 * @property {string} callId
 * @property {string} name
 * @property {string} output                   JSON string the tool returned (model-facing).
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * A realtime event exchanged over the WebRTC data channel ("oai-events").
 * Discriminated on `.type` (see REALTIME_EVENTS in constants).
 * @typedef {{ type: string, [key: string]: any }} RealtimeDataChannelEvent
 *
 * One chunk of audio. Retained for typing completeness; with WebRTC the audio
 * is carried on the RTP media track, not as application-level chunks.
 * @typedef {Object} AudioChunk
 * @property {MediaStreamTrack} [track]        The negotiated audio track.
 * @property {number} [seq]
 */

/**
 * Normalized request shape for the backend property/search layer.
 * Mirrors the inputs of the existing `search_properties` tool so the voice
 * feature speaks the same language as the text chatbot.
 * @typedef {Object} BackendSearchRequest
 * @property {string} [category]
 * @property {string} [unit_type]
 * @property {string} [location]
 * @property {string} [city]
 * @property {number} [min_price]
 * @property {number} [max_price]
 * @property {string} [finishing_type]
 * @property {string} [delivery_status]
 * @property {number} [max_down_payment]
 * @property {number} [min_installment_duration]
 * @property {string} [developer_name]
 * @property {string} [project_name]
 * @property {number} [max_results]
 * @property {number} [offset]
 * @property {string} [language]
 */

/**
 * Normalized response from the backend search layer.
 * @typedef {Object} BackendSearchResponse
 * @property {any[]} properties
 * @property {number} returned
 * @property {number} [total_matching]
 * @property {boolean} [has_more]
 * @property {number} [offset]
 */

/**
 * Raw event object as emitted by the OpenAI Realtime API.
 * (Open-ended — the API has many event types; we discriminate on `.type`.)
 * @typedef {{ type: string, [key: string]: any }} RealtimeServerEvent
 */

// No runtime exports — this module exists purely for its typedefs.
export {};
