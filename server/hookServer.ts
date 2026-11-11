import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HookEvent, HoldDecision, SessionStore } from './sessions';

export interface HookServerOptions {
  port: number;
  /** How long to hold a PermissionRequest for a device decision before letting the laptop prompt show. */
  holdMs: () => number;
  /** Should this request skip the device and go straight to the laptop? Returns the reason, or false to hold. */
  shouldSkipHold: (sessionId: string) => Promise<string | false>;
  /** Called after every hook event is applied. */
  onEvent?: (sessionId: string) => void;
  /** Called after a Codex turn ends (to look for a question it asked). */
  onCodexStop?: (ev: HookEvent) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const DENY_MESSAGE = 'Denied from AgentThing (the desk controller). Ask the user before retrying this action.';

/**
 * Tiny HTTP server that Claude Code's hooks POST to.
 *
 *   POST /hook   – any hook event (routes on hook_event_name)
 *   GET  /state  – current board state as JSON (debugging)
 *   GET  /health – 200 if up
 */
export function startHookServer(store: SessionStore, opts: HookServerOptions): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      opts.log('error', `hook handler failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url || '/';
    if (req.method === 'GET' && url.startsWith('/health')) return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.startsWith('/state')) return json(res, 200, store.snapshot());
    if (req.method !== 'POST' || !url.startsWith('/hook')) return json(res, 404, { error: 'not found' });

    const body = await readBody(req);
    let ev: HookEvent;
    try {
      ev = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'bad json' });
    }
    // Which agent sent it: AgentThing's Codex hooks post to /hook?agent=codex. Hooks copied
    // over from Claude Code's settings don't say, so also recognise Codex by its transcript
    // living under ~/.codex/.
    const agent = new URL(url, 'http://localhost').searchParams.get('agent');
    const fromCodex = agent === 'codex' || (typeof ev.transcript_path === 'string' && ev.transcript_path.includes('/.codex/'));
    ev.agent = fromCodex ? 'codex' : 'claude';
    if (!ev.session_id || !ev.hook_event_name) return json(res, 400, { error: 'missing fields' });

    // Subagent events would double-count the parent session. Ignore them.
    if (ev.agent_id) return json(res, 200, {});

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;

    const s = store.apply(ev, headers);
    opts.onEvent?.(s.id);
    if (ev.agent === 'codex' && ev.hook_event_name === 'Stop') opts.onCodexStop?.(ev);

    if (ev.hook_event_name !== 'PermissionRequest') return json(res, 200, {});

    // ---- PermissionRequest: decide whether to hold for the device.
    // Codex can't take an answer from a hook, so its questions go straight to the laptop.
    const skip = ev.agent === 'codex' && s.pending?.kind === 'question' ? 'Codex questions are answered in the app' : await opts.shouldSkipHold(s.id);
    if (skip) {
      opts.log('info', `permission for "${s.title}" → laptop (${skip})`);
      store.markOnLaptop(s);
      return json(res, 200, {}); // laptop shows its normal prompt
    }

    opts.log('info', `permission for "${s.title}" held for device`);
    const decision: HoldDecision = await store.hold(s, opts.holdMs());
    opts.log('info', `permission for "${s.title}" → ${typeof decision === 'object' ? 'answered' : decision}`);

    // Claude Code: allow echoes the input back (AskUserQuestion and ExitPlanMode require updatedInput).
    // Codex: a bare allow; it refuses updatedInput ("reserved… fail closed today").
    const input = ev.tool_input || {};
    if (decision === 'allow' || typeof decision === 'object') {
      const allow =
        ev.agent === 'codex'
          ? { behavior: 'allow' }
          : { behavior: 'allow', updatedInput: typeof decision === 'object' ? { ...input, answers: decision.answers } : input };
      return json(res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow } });
    }
    if (decision === 'deny') {
      return json(res, 200, {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: DENY_MESSAGE },
        },
      });
    }
    // 'release': no decision → Claude Code shows its normal prompt on the laptop.
    return json(res, 200, {});
  }

  server.on('listening', () => {
    store.hookPort = opts.port;
    store.hookListening = true;
    store.setToast(`Listening on :${opts.port}`, 'ok');
    opts.log('info', `hook server listening on http://127.0.0.1:${opts.port}`);
  });
  server.on('error', (e) => {
    store.hookListening = false;
    opts.log('error', `hook server error: ${e.message}`);
    store.setToast(`Port ${opts.port} failed: ${e.message}`, 'err');
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
