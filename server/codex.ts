import { execFile } from 'node:child_process';
import { open as openFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Question } from '../shared/protocol';
import { isCodexAskTool, parseCodexQuestions } from './sessions';

/**
 * Read-only view of Codex's local thread list (the ChatGPT app's Codex
 * threads, and the Codex CLI), for titles, models and archive state.
 *
 * Codex keeps it in ~/.codex/state_5.sqlite, table `threads`. That's not a
 * documented API, so any failure just means "no extra info": the board falls
 * back to the first prompt for a title.
 */

const DB = join(homedir(), '.codex', 'state_5.sqlite');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexThread {
  title?: string;
  model?: string;
  archived: boolean;
}

/** Look up these thread ids (the hooks' session_id). Unknown ids are left out of the result. */
export async function codexThreads(ids: string[]): Promise<Map<string, CodexThread>> {
  const out = new Map<string, CodexThread>();
  const safe = ids.filter((id) => UUID.test(id));
  if (safe.length === 0) return out;
  const sql =
    `select id, coalesce(nullif(name, ''), nullif(title, '')) as title, model, archived ` +
    `from threads where id in (${safe.map((id) => `'${id}'`).join(',')})`;
  const rows = await new Promise<string>((resolve) => {
    execFile('sqlite3', ['-readonly', '-json', DB, sql], { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
  if (!rows.trim()) return out;
  try {
    for (const r of JSON.parse(rows) as { id: string; title: string | null; model: string | null; archived: number }[]) {
      out.set(r.id, {
        title: r.title?.trim() || undefined,
        model: r.model || undefined,
        archived: r.archived === 1,
      });
    }
  } catch {
    // unexpected shape: no extra info
  }
  return out;
}

export function isCodexThreadId(id: string): boolean {
  return UUID.test(id);
}

const CODEX_DIR = join(homedir(), '.codex');
const TAIL_BYTES = 1_000_000;

/**
 * The question Codex asked in this turn (request_user_input_async) and that
 * hasn't been answered yet, read from the end of the thread's transcript.
 * Codex's hooks don't report these questions, but the transcript records
 * them. Only files under ~/.codex are read. Undefined if there's none.
 */
export async function pendingCodexQuestions(transcriptPath: unknown, turnId?: string): Promise<Question[] | undefined> {
  if (typeof transcriptPath !== 'string') return undefined;
  let file: string;
  try {
    file = await realpath(transcriptPath);
  } catch {
    return undefined;
  }
  if (!file.startsWith(CODEX_DIR + '/') || !file.endsWith('.jsonl')) return undefined;

  let text = '';
  const fh = await openFile(file, 'r').catch(() => null);
  if (!fh) return undefined;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
  } finally {
    await fh.close();
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let r: { type?: string; payload?: Record<string, any> };
    try {
      r = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const p = r.payload || {};
    // Reached a message from the user before any question: nothing waiting (or it was answered).
    if (r.type === 'response_item' && p.type === 'message' && p.role === 'user') return undefined;
    if (r.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') return undefined;
    if (r.type === 'response_item' && p.type === 'function_call' && isCodexAskTool(p.name)) {
      const t = p.internal_chat_message_metadata_passthrough?.turn_id;
      if (turnId && t && t !== turnId) return undefined;
      try {
        return parseCodexQuestions(JSON.parse(String(p.arguments)));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The message that answers Codex's question(s): the picked option, or "question: answer" lines for several. */
export function codexAnswerText(questions: Question[], answers: Record<string, string>): string {
  if (questions.length === 1) return answers[questions[0].question] ?? '';
  return questions.map((q) => `${q.question} ${answers[q.question] ?? ''}`.trim()).join('\n');
}
