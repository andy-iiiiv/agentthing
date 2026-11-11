/**
 * Shared types between the DeskThing server module and the device client.
 * Keep this file dependency-free: it is bundled into both sides.
 */

export type SessionStatus =
  | 'running'   // Claude is working (prompt submitted / tool running)
  | 'needs_you' // a permission request is waiting
  | 'idle'      // last turn finished, nothing queued
  | 'ended';    // SessionEnd received; row drops off shortly

export interface QuestionOption {
  label: string;
  description?: string;
}

/** One of the 1–4 questions in an AskUserQuestion call. */
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingRequest {
  /** tool: approve/deny a tool call. question: Claude is asking (AskUserQuestion). plan: plan approval (ExitPlanMode). */
  kind: 'tool' | 'question' | 'plan';
  toolName: string;
  /** For kind 'question': the questions, answerable from the device. */
  questions?: Question[];
  /** One-line human summary of what the tool wants to do. */
  summary: string;
  /** Longer detail (command text, file path, etc.) shown on the card. */
  detail?: string;
  /** True while the PermissionRequest hook is being held open for a device decision. */
  heldOnDevice: boolean;
  since: number;
}

/** Which coding agent a session belongs to. */
export type AgentKind = 'claude' | 'codex';

export interface SessionView {
  id: string;
  /** Claude Code, or Codex (the ChatGPT app's Codex threads / the Codex CLI). */
  agent: AgentKind;
  /** Display title: Claude's session_title, else first prompt, else folder name. */
  title: string;
  cwd: string;
  folder: string;
  status: SessionStatus;
  statusSince: number;
  /** Last tool Claude invoked, e.g. "Bash: npm test". */
  lastTool?: string;
  /** First line of Claude's last response (from Stop). */
  lastMessage?: string;
  /** Most recent user prompt (first line). */
  lastPrompt?: string;
  model?: string;
  pending?: PendingRequest;
  updatedAt: number;
  /** True if this is the session most recently focused from the device. */
  focused: boolean;
}

export interface BoardState {
  sessions: SessionView[];
  focusedId: string | null;
  serverTime: number;
  /** Something the server wants the device to flash briefly. */
  toast?: { text: string; kind: 'ok' | 'warn' | 'err'; at: number };
  hookServer: { port: number; listening: boolean };
  /** The server module's version; the device reloads if its own differs. */
  appVersion?: string;
  /** Hold-to-talk: on or off, the dictation app's name and its key. */
  dictation?: { enabled: boolean; app: string; key: string };
}

/** Hold-to-talk (via Rhino on the Mac). One dictation at a time. */
export interface VoiceState {
  sessionId: string;
  /** starting: bringing the session up · listening: Rhino is recording · typing: Rhino is transcribing · ready: typed, waiting for Send */
  phase: 'idle' | 'starting' | 'listening' | 'typing' | 'ready';
  /** What Rhino typed, when we could read it. */
  text?: string;
}

/** Server → client */
export type ToClient =
  | { type: 'state'; payload: BoardState }
  | { type: 'toast'; payload: { text: string; kind: 'ok' | 'warn' | 'err' } }
  | { type: 'voice'; payload: VoiceState };

/**
 * Client → server.
 *  focus   – bring the session up on the Mac (a held request stays held)
 *  approve / deny – answer the held request
 *  release – hand the held request to the laptop prompt, and focus it there
 *  answer  – answer a held question: question text → chosen label(s), comma-joined
 *  voice-* – hold-to-talk: start (dial held), stop (released), send (Return in Claude),
 *            edit (leave the text in Claude's prompt box and bring the session up to fix it), cancel
 */
export type CmdRequest =
  | 'focus'
  | 'approve'
  | 'deny'
  | 'release'
  | 'voice-start'
  | 'voice-stop'
  | 'voice-send'
  | 'voice-edit'
  | 'voice-cancel';
export type Answers = Record<string, string>;

export type ToServer =
  | { type: 'board'; request: 'get' }
  | { type: 'cmd'; request: CmdRequest; payload: { sessionId: string } }
  | { type: 'cmd'; request: 'answer'; payload: { sessionId: string; answers: Answers } }
  /** Raw hardware input, logged on the server so key codes can be checked on a real unit. */
  | { type: 'debug'; request: 'input'; payload: { kind: string; code?: string; dx?: number; dy?: number } };

/** Sort weight: lower comes first on the board. */
export const STATUS_RANK: Record<SessionStatus, number> = {
  needs_you: 0,
  idle: 1,
  running: 2,
  ended: 3,
};
