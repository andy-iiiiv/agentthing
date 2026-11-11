import { basename } from 'node:path';
import type { AgentKind, Answers, BoardState, Question, SessionStatus, SessionView } from '../shared/protocol';
import { STATUS_RANK } from '../shared/protocol';
import { APP_VERSION } from '../shared/version';
import { cleanPrompt, cleanReply, firstLineOf, truncate } from './text';

/** Raw hook payload from Claude Code. Only the fields we read are typed. */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  /** Set by the hook server from the URL (?agent=codex); Claude Code otherwise. */
  agent?: AgentKind;
  turn_id?: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  // SessionStart
  source?: string;
  model?: string;
  session_title?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreToolUse / PermissionRequest
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // Stop
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  // Notification
  notification_type?: string;
  message?: string;
  title?: string;
  // SessionEnd
  reason?: string;
  // Subagent context (we ignore subagent events)
  agent_id?: string;
  agent_type?: string;
}

interface SessionRecord extends Omit<SessionView, 'focused'> {
  /** True once Claude or Desktop gave us a title; first-prompt titles never overwrite it. */
  titleFromClaude?: boolean;
  /**
   * Codex: the pending question was asked with request_user_input_async, which
   * doesn't wait. It's answered by sending the thread a new message, not by a hook reply.
   */
  answerByMessage?: boolean;
  /** Claude Desktop's id for this session ("local_…"), for the focus deep link. */
  hostId?: string;
  /** Inbox socket + token captured from SessionStart headers (phase 2: push-to-talk). */
  messagingSocket?: string;
  messagingToken?: string;
  /** Resolver for a held PermissionRequest HTTP response. */
  holdResolve?: (decision: HoldDecision) => void;
  holdTimer?: NodeJS.Timeout;
}

export type HoldDecision = 'allow' | 'deny' | 'release' | { answers: Answers };

export type ChangeListener = (state: BoardState) => void;

const ENDED_LINGER_MS = 4000;

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private focusedId: string | null = null;
  private toast: BoardState['toast'];
  private listeners = new Set<ChangeListener>();
  public hookPort = 0;
  public hookListening = false;

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- views

  snapshot(): BoardState {
    const sessions = [...this.sessions.values()]
      .map((s) => this.toView(s))
      .sort((a, b) => {
        const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (r !== 0) return r;
        // Within a rank, the one that changed most recently first.
        return b.statusSince - a.statusSince;
      });
    return {
      sessions,
      focusedId: this.focusedId,
      serverTime: Date.now(),
      toast: this.toast,
      hookServer: { port: this.hookPort, listening: this.hookListening },
      appVersion: APP_VERSION,
    };
  }

  private toView(s: SessionRecord): SessionView {
    const { messagingSocket, messagingToken, holdResolve, holdTimer, titleFromClaude, hostId, answerByMessage, ...rest } = s;
    void messagingSocket; void messagingToken; void holdResolve; void holdTimer; void titleFromClaude; void hostId; void answerByMessage;
    return { ...rest, focused: s.id === this.focusedId };
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  // ------------------------------------------------------------ mutations

  setToast(text: string, kind: 'ok' | 'warn' | 'err' = 'ok') {
    this.toast = { text, kind, at: Date.now() };
    this.emit();
  }

  setFocused(id: string | null) {
    this.focusedId = id;
    this.emit();
  }

  /** Create-or-update from any hook event. Returns the record. */
  upsert(ev: HookEvent): SessionRecord {
    let s = this.sessions.get(ev.session_id);
    const now = Date.now();
    if (!s) {
      const cwd = ev.cwd || '';
      s = {
        id: ev.session_id,
        agent: ev.agent ?? 'claude',
        title: ev.session_title || basename(cwd) || ev.session_id.slice(0, 8),
        cwd,
        folder: basename(cwd),
        status: 'idle',
        statusSince: now,
        updatedAt: now,
      };
      this.sessions.set(s.id, s);
    }
    if (ev.cwd && ev.cwd !== s.cwd) {
      s.cwd = ev.cwd;
      s.folder = basename(ev.cwd);
    }
    if (ev.session_title) {
      s.title = ev.session_title;
      s.titleFromClaude = true;
    }
    if (ev.model) s.model = shortModel(ev.model);
    s.updatedAt = now;
    return s;
  }

  setStatus(s: SessionRecord, status: SessionStatus) {
    if (s.status !== status) {
      s.status = status;
      s.statusSince = Date.now();
    }
    s.updatedAt = Date.now();
  }

  /** Apply a hook event to session state. Does not handle the hold itself. */
  apply(ev: HookEvent, headers: Record<string, string | undefined>): SessionRecord {
    const s = this.upsert(ev);
    switch (ev.hook_event_name) {
      case 'SessionStart': {
        const sock = headers['x-cc-socket'];
        const tok = headers['x-cc-token'];
        if (sock) s.messagingSocket = sock;
        if (tok) s.messagingToken = tok;
        // A resume/compact start keeps whatever status it had.
        if (ev.source === 'startup' || ev.source === 'clear' || !s.status) this.setStatus(s, 'idle');
        break;
      }
      case 'UserPromptSubmit': {
        const text = cleanPrompt(ev.prompt);
        const line = firstLineOf(text);
        if (text && line) {
          s.lastPrompt = text;
          // No title from Claude yet? Use the first prompt until one arrives.
          if (!ev.session_title && !s.titleFromClaude && (s.title === s.folder || s.title === s.id.slice(0, 8))) {
            s.title = truncate(line, 42);
          }
        }
        this.clearPending(s, 'release');
        this.setStatus(s, 'running');
        break;
      }
      case 'PreToolUse': {
        const codexQs = ev.agent === 'codex' && isCodexAskTool(ev.tool_name) ? parseCodexQuestions(ev.tool_input) : undefined;
        if (codexQs) {
          this.setCodexQuestionOn(s, codexQs);
          break;
        }
        s.lastTool = describeTool(ev.tool_name, ev.tool_input);
        this.clearPending(s, 'release'); // a tool running means any permission got answered
        this.setStatus(s, 'running');
        break;
      }
      case 'PermissionRequest': {
        // A newer request supersedes any hold still open for this session.
        if (s.holdResolve) s.holdResolve('release');
        const kind = isQuestionTool(ev.tool_name) ? 'question' : ev.tool_name === 'ExitPlanMode' ? 'plan' : 'tool';
        const questions = kind === 'question' ? parseQuestions(ev.tool_input) : undefined;
        s.pending = {
          // A Claude question we can't parse falls back to approve/deny. Codex questions can only
          // be answered in the app, so they stay questions (shown as "waiting on the laptop").
          kind: kind === 'question' && !questions && ev.agent !== 'codex' ? 'tool' : kind,
          questions,
          toolName: ev.tool_name || 'tool',
          summary: describeTool(ev.tool_name, ev.tool_input),
          detail: toolDetail(ev.tool_name, ev.tool_input),
          heldOnDevice: true, // optimistic; markOnLaptop() flips it if the laptop takes it
          since: Date.now(),
        };
        this.setStatus(s, 'needs_you');
        break;
      }
      case 'Notification': {
        if (ev.notification_type === 'permission_prompt') {
          if (!s.pending) {
            s.pending = {
              kind: 'tool',
              toolName: 'permission',
              summary: ev.message || 'Needs your permission',
              heldOnDevice: false,
              since: Date.now(),
            };
          }
          this.setStatus(s, 'needs_you');
        } else if (ev.notification_type === 'idle_prompt') {
          this.clearPending(s, 'release');
          this.setStatus(s, 'idle');
        }
        break;
      }
      case 'Stop': {
        s.lastMessage = cleanReply(ev.last_assistant_message);
        s.lastTool = undefined;
        // A Codex question asked this turn is still waiting for its answer.
        if (s.answerByMessage && s.pending) {
          this.setStatus(s, 'needs_you');
          break;
        }
        this.clearPending(s, 'release');
        this.setStatus(s, 'idle');
        break;
      }
      case 'Interrupt': {
        // Codex: the user stopped the turn.
        this.clearPending(s, 'release');
        this.setStatus(s, 'idle');
        break;
      }
      case 'SessionEnd': {
        this.clearPending(s, 'release');
        this.setStatus(s, 'ended');
        setTimeout(() => {
          const cur = this.sessions.get(s.id);
          if (cur && cur.status === 'ended') {
            this.sessions.delete(s.id);
            if (this.focusedId === s.id) this.focusedId = null;
            this.emit();
          }
        }, ENDED_LINGER_MS).unref?.();
        break;
      }
      default:
        break;
    }
    this.emit();
    return s;
  }

  /** Title and model from the agent's app (e.g. a Codex thread). */
  applyMeta(id: string, meta: { title?: string; model?: string }) {
    const s = this.sessions.get(id);
    if (!s) return;
    let changed = false;
    if (meta.title && s.title !== meta.title) {
      s.title = meta.title;
      s.titleFromClaude = true;
      changed = true;
    }
    const model = meta.model ? shortModel(meta.model) : undefined;
    if (model && s.model !== model) { s.model = model; changed = true; }
    if (changed) this.emit();
  }

  /** Fill in what Claude Desktop knows about a session: its id and sidebar title. */
  applyDesktop(id: string, info: { hostId: string; title?: string; model?: string }) {
    const s = this.sessions.get(id);
    if (!s) return;
    let changed = false;
    const model = info.model ? shortModel(info.model) : undefined;
    if (model && s.model !== model) { s.model = model; changed = true; }
    if (s.hostId !== info.hostId) { s.hostId = info.hostId; changed = true; }
    if (info.title && s.title !== info.title) {
      s.title = info.title;
      s.titleFromClaude = true;
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Drop a session from the board (archived or deleted in Desktop). */
  remove(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.clearPending(s, 'release');
    this.sessions.delete(id);
    if (this.focusedId === id) this.focusedId = null;
    this.emit();
  }

  /** Hand every held request to the laptop. Returns how many there were. */
  releaseAll(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.holdResolve) { s.holdResolve('release'); n += 1; }
    }
    return n;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  // --------------------------------------------------------------- holds

  /**
   * Hold a PermissionRequest until the device decides, the laptop takes over, or
   * the timeout elapses. Resolves with the decision to return to Claude Code.
   */
  hold(s: SessionRecord, timeoutMs: number): Promise<HoldDecision> {
    if (s.holdResolve) s.holdResolve('release'); // only one held request per session
    return new Promise<HoldDecision>((resolve) => {
      if (s.pending) s.pending.heldOnDevice = true;
      s.holdResolve = (d) => {
        s.holdResolve = undefined;
        if (s.holdTimer) clearTimeout(s.holdTimer);
        s.holdTimer = undefined;
        if (s.pending) s.pending.heldOnDevice = false;
        if (d !== 'release') {
          // Decision made on the device: Claude will proceed, clear the card.
          s.pending = undefined;
          this.setStatus(s, 'running');
        }
        this.emit();
        resolve(d);
      };
      s.holdTimer = setTimeout(() => s.holdResolve?.('release'), timeoutMs);
      s.holdTimer.unref?.();
      this.emit();
    });
  }

  /** The laptop is handling this request: show it as waiting there, not here. */
  markOnLaptop(s: SessionRecord) {
    if (s.pending) s.pending.heldOnDevice = false;
    this.emit();
  }

  /** Resolve a held request if there is one. Returns false if nothing was held. */
  decide(id: string, d: HoldDecision): boolean {
    const s = this.sessions.get(id);
    if (!s?.holdResolve) return false;
    s.holdResolve(d);
    return true;
  }

  private clearPending(s: SessionRecord, d: HoldDecision) {
    if (s.holdResolve) s.holdResolve(d);
    s.pending = undefined;
    s.answerByMessage = false;
  }

  /** A Codex question (request_user_input_async) is waiting on this session. */
  setCodexQuestion(id: string, questions: Question[]) {
    const s = this.sessions.get(id);
    if (s) this.setCodexQuestionOn(s, questions);
  }

  private setCodexQuestionOn(s: SessionRecord, questions: Question[]) {
    if (s.answerByMessage && s.pending?.questions && JSON.stringify(s.pending.questions) === JSON.stringify(questions)) return;
    s.pending = {
      kind: 'question',
      toolName: 'request_user_input_async',
      summary: `Question: ${truncate(questions[0].question, 90)}`,
      questions,
      // Answerable from the device only if there are options to pick from.
      heldOnDevice: questions.every((q) => q.options.length > 0),
      since: Date.now(),
    };
    s.answerByMessage = true;
    this.setStatus(s, 'needs_you');
    this.emit();
  }

  /** Is the pending question one that's answered by messaging the thread (Codex)? */
  answersByMessage(id: string): boolean {
    const s = this.sessions.get(id);
    return !!(s?.answerByMessage && s.pending);
  }

  // ------------------------------------------------------------- helpers

  private emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try { fn(snap); } catch (e) { console.error('[agentthing] listener failed', e); }
    }
  }
}

// ---------------------------------------------------------------- utils

function firstLine(text?: string): string | undefined {
  const line = firstLineOf(text);
  return line ? truncate(line.trim(), 160) : undefined;
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-5-20260101[1m]" → "Sonnet 5". Unknown shapes pass through trimmed. */
export function shortModel(m: string): string {
  if (/^gpt-/i.test(m)) return 'GPT-' + m.slice(4); // Codex: "gpt-5.5-codex" → "GPT-5.5-codex"
  const bare = m.replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const hit = /^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/i.exec(bare);
  if (!hit) return bare;
  const family = hit[1][0].toUpperCase() + hit[1].slice(1).toLowerCase();
  return `${family} ${hit[2]}${hit[3] ? '.' + hit[3] : ''}`;
}

/** "Bash: npm test" / "Edit: src/app.ts" / "WebFetch: example.com" */
export function describeTool(name?: string, input?: Record<string, unknown>): string {
  if (!name) return 'tool';
  const i = input || {};
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  switch (name) {
    case 'Bash':
      return `Bash: ${truncate(firstLine(str('command')) || '', 80)}`;
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return `${name}: ${shortPath(str('file_path') || str('notebook_path') || '')}`;
    case 'Glob':
    case 'Grep':
      return `${name}: ${truncate(str('pattern') || '', 60)}`;
    case 'WebFetch':
      return `WebFetch: ${hostOf(str('url'))}`;
    case 'WebSearch':
      return `WebSearch: ${truncate(str('query') || '', 60)}`;
    case 'Agent':
      return `Agent: ${truncate(str('description') || '', 60)}`;
    case 'AskUserQuestion': {
      const q = parseQuestions(i)?.[0];
      return q ? `Question: ${truncate(q.question, 90)}` : 'Has a question';
    }
    // Codex
    case 'request_user_input':
      return 'Has a question';
    case 'shell':
    case 'local_shell':
    case 'exec_command':
    case 'unified_exec': {
      const cmd = commandText(i);
      return `Shell: ${truncate(str('description') || firstLine(cmd) || '', 80)}`;
    }
    case 'apply_patch':
      return `Edit: ${truncate(str('description') || patchFiles(i).map(shortPath).join(', ') || 'files', 80)}`;
    case 'ExitPlanMode':
      return 'Plan ready for review';
    default:
      return name.replace(/^mcp__/, '');
  }
}

function toolDetail(name?: string, input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const codexCmd = commandText(input);
  if (codexCmd && name !== 'Bash') return truncate(codexCmd, 400);
  if (name === 'apply_patch') return patchFiles(input).join('\n') || undefined;
  if (name === 'AskUserQuestion') return undefined; // the card shows the questions themselves
  if (name === 'ExitPlanMode') return typeof input.plan === 'string' ? cleanReply(input.plan) : undefined;
  if (name === 'Bash' && typeof input.command === 'string') return truncate(input.command, 400);
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.url === 'string') return input.url;
  try {
    return truncate(JSON.stringify(input), 300);
  } catch {
    return undefined;
  }
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

function hostOf(u?: string): string {
  if (!u) return '';
  try { return new URL(u).host; } catch { return truncate(u, 40); }
}

/** AskUserQuestion's tool_input.questions, validated. Undefined if it doesn't look right. */
export function parseQuestions(input?: Record<string, unknown>): Question[] | undefined {
  const raw = input?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') return undefined;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string' || !Array.isArray(r.options)) return undefined;
    const options = r.options
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as Record<string, unknown>).label === 'string')
      .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : undefined }));
    if (options.length === 0) return undefined;
    out.push({
      question: r.question,
      header: typeof r.header === 'string' ? r.header : undefined,
      options,
      multiSelect: r.multiSelect === true,
    });
  }
  return out;
}

/** Tools that ask the user something rather than asking permission. */
function isQuestionTool(name?: string): boolean {
  return name === 'AskUserQuestion' || name === 'request_user_input';
}

/** Codex shell tools take the command as a string or an argv array (often ["bash", "-lc", "…"]). */
function commandText(input: Record<string, unknown>): string | undefined {
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    const argv = c as string[];
    const i = argv.findIndex((a) => a === '-lc' || a === '-c');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : argv.join(' ');
  }
  return undefined;
}

/** Files named in a Codex apply_patch input ("*** Update File: path"). */
function patchFiles(input: Record<string, unknown>): string[] {
  const text = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : '';
  const out: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

/** Codex's question tools: request_user_input_async returns at once; the reply comes as a new message. */
export function isCodexAskTool(name?: string): boolean {
  return name === 'request_user_input_async';
}

/** Codex question input: { questions: [ { title, options?: string[] } ] } → our Question shape. */
export function parseCodexQuestions(input?: Record<string, unknown>): Question[] | undefined {
  const raw = input?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') return undefined;
    const r = q as Record<string, unknown>;
    if (typeof r.title !== 'string' || !r.title.trim()) return undefined;
    const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : [];
    out.push({ question: r.title.trim(), options: options.map((label) => ({ label })), multiSelect: false });
  }
  return out;
}
