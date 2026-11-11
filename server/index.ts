import { createDeskThing } from '@deskthing/server';
import { DESKTHING_EVENTS, SETTING_TYPES, type AppSettings } from '@deskthing/types';
import type { Server } from 'node:http';
import type { BoardState, ToClient, ToServer } from '../shared/protocol';
import { claudeHooks, codexHooks } from './agentHooks';
import { findDesktopSession, inFrontOnLaptop, listDesktopSessions } from './desktop';
import { appInfo, DICTATION_APPS, parseKeyCombo } from './dictation';
import { startHookServer } from './hookServer';
import { codexAnswerText, codexThreads, pendingCodexQuestions } from './codex';
import { appIsFrontmost, claudeIsFrontmost, CODEX_BUNDLE_ID, focusCodexThread, focusSession, sendCodexMessage } from './mac';
import { SessionStore } from './sessions';
import { Voice } from './voice';

const DeskThing = createDeskThing<ToServer, ToClient>();

const store = new SessionStore();
let hookServer: Server | undefined;

// ------------------------------------------------------------- settings

// Renamed settings (new name = new default, so an old saved value doesn't carry over):
//   checkFrontmost (on)  → laptopWhenInFront (off)  in 0.3.1
//   holdSeconds (90)     → waitSeconds (120)        in 0.3.2
const DEFAULTS = {
  port: 8765,
  waitSeconds: 120,
  laptopWhenInFront: false,
  claudeHooks: false,
  codexHooks: false,
  dictationApp: 'rhino',
  dictationKey: 'right cmd',
};
/** Claude stops waiting on the PermissionRequest hook at 150 s (claude-settings/hooks.json). */
const MAX_WAIT_SECONDS = 140;
let settings = { ...DEFAULTS };

const SETTINGS: AppSettings = {
  claudeHooks: {
    id: 'claudeHooks',
    type: SETTING_TYPES.BOOLEAN,
    label: 'Install Claude Code hooks',
    description:
      'Adds AgentThing’s hooks to ~/.claude/settings.json (backed up first) so Claude Code sessions show up here. Turning it off takes them back out. Start a new Claude Code session afterwards.',
    value: DEFAULTS.claudeHooks,
  },
  codexHooks: {
    id: 'codexHooks',
    type: SETTING_TYPES.BOOLEAN,
    label: 'Install Codex hooks (ChatGPT app)',
    description:
      'Adds AgentThing’s hooks to ~/.codex/hooks.json (backed up first) so Codex threads in the ChatGPT app (and the Codex CLI) show up here. Then trust them in ChatGPT → Settings → Hooks. Turning it off takes them back out.',
    value: DEFAULTS.codexHooks,
  },
  dictationApp: {
    id: 'dictationApp',
    type: SETTING_TYPES.SELECT,
    label: 'Dictation app (hold the dial to talk)',
    description:
      'Holding the dial holds this app’s push-to-talk key, so your words are typed into Claude. Needs Accessibility permission for DeskThing. Choosing an app fills in its usual key below.',
    value: DEFAULTS.dictationApp,
    options: DICTATION_APPS.map((a) => ({ value: a.value, label: a.label })),
  },
  dictationKey: {
    id: 'dictationKey',
    type: SETTING_TYPES.STRING,
    label: 'Dictation key',
    description:
      'Your dictation app’s push-to-talk key, held while you hold the dial. Examples: right cmd, fn, option+space, right option, ctrl+shift+d. Set the app to the same key.',
    value: DEFAULTS.dictationKey,
  },
  port: {
    id: 'port',
    type: SETTING_TYPES.NUMBER,
    label: 'Hook server port',
    description: 'Claude Code hooks POST to http://127.0.0.1:<port>/hook. Change the hooks snippet to match.',
    value: DEFAULTS.port,
    min: 1024,
    max: 65535,
  },
  waitSeconds: {
    id: 'waitSeconds',
    type: SETTING_TYPES.NUMBER,
    label: 'Wait on the Car Thing (seconds)',
    description: `How long a question or permission request waits on the Car Thing before it moves to the laptop. At most ${MAX_WAIT_SECONDS}: Claude stops waiting on the hook at 150.`,
    value: DEFAULTS.waitSeconds,
    min: 10,
    max: MAX_WAIT_SECONDS,
  },
  laptopWhenInFront: {
    id: 'laptopWhenInFront',
    type: SETTING_TYPES.BOOLEAN,
    label: 'Send to the laptop when you’re looking at that session there',
    description:
      'Off: while the Car Thing is connected, questions and permission requests always wait on it (hand one over with On laptop). On: if that session is in front in Claude on the laptop, its prompt shows there instead.',
    value: DEFAULTS.laptopWhenInFront,
  },
};

function readSettings(s: AppSettings | null | undefined) {
  if (!s) return;
  const num = (k: keyof typeof DEFAULTS) => {
    const v = s[k]?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
  };
  const bool = (k: keyof typeof DEFAULTS) => {
    const v = s[k]?.value;
    return typeof v === 'boolean' ? v : DEFAULTS[k];
  };
  const str = (k: keyof typeof DEFAULTS) => {
    const v = s[k]?.value;
    return typeof v === 'string' ? v : (DEFAULTS[k] as string);
  };
  settings = {
    port: num('port') as number,
    waitSeconds: Math.min(MAX_WAIT_SECONDS, num('waitSeconds') as number),
    laptopWhenInFront: bool('laptopWhenInFront') as boolean,
    claudeHooks: bool('claudeHooks') as boolean,
    codexHooks: bool('codexHooks') as boolean,
    dictationApp: str('dictationApp'),
    dictationKey: str('dictationKey'),
  };
}

// ---------------------------------------------------------------- logging

const log = (level: 'info' | 'warn' | 'error', msg: string) => {
  const line = `[agentthing] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

// --------------------------------------------------------- client wiring

function push(state: BoardState) {
  DeskThing.send({ type: 'state', payload: { ...state, dictation: dictationInfo() } });
}

store.onChange(push);

/**
 * When did the device last talk to us? The client asks for the board every
 * 10 s, so silence means the Car Thing is unplugged or AgentThing isn't open.
 * Holding a permission request then would just stall Claude on the laptop.
 */
let lastClientSeen = 0;
const DEVICE_STALE_MS = 15_000;
const deviceConnected = () => Date.now() - lastClientSeen < DEVICE_STALE_MS;

// Car Thing gone quiet (unplugged, or AgentThing closed on it)? Move anything waiting there to the laptop.
const watchDevice = setInterval(() => {
  if (deviceConnected()) return;
  void voice.abort('device not connected');
  const n = store.releaseAll();
  if (n) log('info', `device not connected: moved ${n} waiting request(s) to the laptop`);
}, 3000);
watchDevice.unref?.();

DeskThing.on('board', (data) => {
  lastClientSeen = Date.now();
  if (data.request === 'get') {
    push(store.snapshot());
    DeskThing.send({ type: 'voice', payload: voice.current() });
  }
});

DeskThing.on('debug', (data) => {
  lastClientSeen = Date.now();
  const p = data.payload;
  if (data.request === 'input' && p) {
    log('info', `input ${p.kind}${p.code ? ` code=${p.code}` : ''}${p.dx !== undefined ? ` dx=${p.dx} dy=${p.dy}` : ''}`);
  }
});

/** When the device last brought each session up on the Mac (see inFrontOnLaptop). */
const deviceFocusAt = new Map<string, number>();

async function focusOnMac(s: { id: string; title: string; hostId?: string; agent: 'claude' | 'codex' }) {
  if (s.agent === 'codex') {
    try {
      deviceFocusAt.set(s.id, Date.now());
      const result = await focusCodexThread(s.id);
      log('info', `focus "${s.title}" (Codex): ${result}`);
    } catch (e) {
      log('warn', `focus failed: ${e instanceof Error ? e.message : String(e)}`);
      DeskThing.send({ type: 'toast', payload: { text: 'Focus failed', kind: 'err' } });
    }
    return;
  }
  try {
    const d = await findDesktopSession(s.id, s.hostId);
    if (d) store.applyDesktop(s.id, { hostId: d.hostId, title: d.title, model: d.model });
    deviceFocusAt.set(s.id, Date.now());
    const result = await focusSession(d?.hostId ?? s.hostId);
    log('info', `focus "${s.title}": ${result}${d ? ` ${d.hostId}` : ' (not found in Desktop)'}`);
    if (result === 'activated') {
      DeskThing.send({ type: 'toast', payload: { text: 'Opened Claude, but couldn’t find that session', kind: 'warn' } });
    }
  } catch (e) {
    log('warn', `focus failed: ${e instanceof Error ? e.message : String(e)}`);
    DeskThing.send({ type: 'toast', payload: { text: 'Focus failed', kind: 'err' } });
  }
}

/** The push-to-talk combo to hold, null when hold-to-talk is off, or why the key can't be used. */
function dictationCombo() {
  if (settings.dictationApp === 'off') return null;
  return parseKeyCombo(settings.dictationKey);
}

/** What the device needs to know about hold-to-talk. */
function dictationInfo(): BoardState['dictation'] {
  const combo = dictationCombo();
  return {
    enabled: !!combo && !('error' in combo),
    app: appInfo(settings.dictationApp).label,
    key: combo && !('error' in combo) ? combo.label : '',
  };
}

const voice = new Voice({
  dictationKey: dictationCombo,
  focus: async (sessionId) => {
    const s = store.get(sessionId);
    if (!s) return false;
    store.setFocused(s.id);
    await focusOnMac(s);
    return true;
  },
  isFront: (sessionId) => (store.get(sessionId)?.agent === 'codex' ? appIsFrontmost(CODEX_BUNDLE_ID) : claudeIsFrontmost()),
  emit: (v) => DeskThing.send({ type: 'voice', payload: v }),
  toast: (text, kind) => DeskThing.send({ type: 'toast', payload: { text, kind } }),
  log,
});

DeskThing.on('cmd', async (data) => {
  lastClientSeen = Date.now();
  const id = data.payload?.sessionId;
  const s = id ? store.get(id) : undefined;
  if (!s) {
    DeskThing.send({ type: 'toast', payload: { text: 'That session is gone', kind: 'warn' } });
    return;
  }
  switch (data.request) {
    case 'focus': {
      // A held request stays held: the card on the device is where it gets answered.
      store.setFocused(s.id);
      await focusOnMac(s);
      break;
    }
    case 'approve':
    case 'deny': {
      const ok = store.decide(s.id, data.request === 'approve' ? 'allow' : 'deny');
      DeskThing.send({
        type: 'toast',
        payload: ok
          ? { text: data.request === 'approve' ? 'Approved' : 'Denied', kind: 'ok' }
          : { text: 'Nothing waiting — answer it on the laptop', kind: 'warn' },
      });
      break;
    }
    case 'answer': {
      const answers = sanitizeAnswers(data.payload?.answers);
      if (answers && store.answersByMessage(s.id)) {
        void answerCodex(s.id, answers);
        break;
      }
      const ok = answers ? store.decide(s.id, { answers }) : false;
      DeskThing.send({
        type: 'toast',
        payload: ok ? { text: 'Answered', kind: 'ok' } : { text: 'That question is gone — answer it on the laptop', kind: 'warn' },
      });
      break;
    }
    case 'voice-start':
      void voice.start(s.id);
      break;
    case 'voice-stop':
      void voice.stop();
      break;
    case 'voice-send':
      void voice.send(s.id);
      break;
    case 'voice-edit':
      void voice.edit(s.id);
      break;
    case 'voice-cancel':
      voice.cancel(s.id);
      break;
    case 'release': {
      // A Codex question: nothing is held; just show it as waiting on the laptop.
      if (store.answersByMessage(s.id)) store.markOnLaptop(s);
      // "Answer on laptop": let Claude show its normal prompt, then bring it up.
      if (store.decide(s.id, 'release')) log('info', `released hold for "${s.title}" to the laptop`);
      store.setFocused(s.id);
      await focusOnMac(s);
      break;
    }
  }
});

/**
 * Answer a Codex question from the device: send the thread the picked option
 * as a new message (that's how request_user_input_async expects replies), then
 * wait for it to show up as the user's next prompt.
 */
async function answerCodex(sessionId: string, answers: Record<string, string>) {
  const s = store.get(sessionId);
  const qs = s?.pending?.questions;
  if (!s || !qs) return;
  const text = codexAnswerText(qs, answers);
  store.markOnLaptop(s); // no double answers while it's on its way
  try {
    await sendCodexMessage(s.id, text);
  } catch (e) {
    log('error', `Codex answer for "${s.title}" failed: ${e instanceof Error ? e.message : String(e)}`);
    DeskThing.send({ type: 'toast', payload: { text: 'Couldn’t send — answer it in ChatGPT', kind: 'err' } });
    await focusOnMac(s);
    return;
  }
  log('info', `Codex answer for "${s.title}" queued`);
  DeskThing.send({ type: 'toast', payload: { text: 'Sending to Codex…', kind: 'ok' } });
  for (let waited = 0; waited < 10_000; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    if (!store.answersByMessage(s.id)) {
      log('info', `Codex answer for "${s.title}" delivered`);
      DeskThing.send({ type: 'toast', payload: { text: 'Answered', kind: 'ok' } });
      return;
    }
  }
  log('warn', `Codex answer for "${s.title}" queued but not seen as a prompt yet; opening the thread`);
  DeskThing.send({ type: 'toast', payload: { text: 'Queued — check the thread in ChatGPT', kind: 'warn' } });
  await focusOnMac(s);
}

/** Only string → string pairs make it through to Claude. */
function sanitizeAnswers(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// ------------------------------------------------- Claude Desktop sync

/**
 * Match board rows to Claude Desktop's session list: take Desktop's sidebar
 * title, learn its id for focusing, and drop sessions archived or deleted
 * there. Sessions Desktop doesn't know (CLI sessions) are left alone.
 */
let syncing = false;
/** Sessions we've matched to a Desktop file at least once. Only those can be dropped for going missing. */
const seenInDesktop = new Set<string>();
async function syncDesktop() {
  if (syncing) return;
  syncing = true;
  try {
    const desktop = await listDesktopSessions();
    const codexIds = store.ids().filter((id) => store.get(id)?.agent === 'codex');
    const codex = codexIds.length ? await codexThreads(codexIds) : new Map();
    for (const id of store.ids()) {
      const s = store.get(id);
      if (!s) continue;
      if (s.agent === 'codex') {
        const t = codex.get(id);
        if (t?.archived) store.remove(id);
        else if (t) store.applyMeta(id, { title: t.title, model: t.model });
        continue;
      }
      const d = desktop.find((x) => x.hostId === s.hostId || x.cliSessionId === id);
      if (!d) {
        // Known to Desktop before and now gone (deleted): drop it.
        if (seenInDesktop.has(id)) { seenInDesktop.delete(id); store.remove(id); }
        continue;
      }
      seenInDesktop.add(id);
      if (d.isArchived) {
        store.remove(id);
        continue;
      }
      store.applyDesktop(id, { hostId: d.hostId, title: d.title, model: d.model });
    }
  } catch (e) {
    log('warn', `desktop sync failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    syncing = false;
  }
}

let syncSoonTimer: NodeJS.Timeout | undefined;
function syncSoon() {
  if (syncSoonTimer) return;
  syncSoonTimer = setTimeout(() => { syncSoonTimer = undefined; void syncDesktop(); }, 1000);
}
const syncEvery = setInterval(() => void syncDesktop(), 15_000);
syncEvery.unref?.();

// ------------------------------------------------------------- lifecycle

async function startHooks() {
  if (hookServer) {
    await new Promise<void>((r) => hookServer!.close(() => r()));
    hookServer = undefined;
  }
  hookServer = startHookServer(store, {
    port: settings.port,
    holdMs: () => settings.waitSeconds * 1000,
    shouldSkipHold: async (sessionId) => {
      if (!deviceConnected()) return 'device not connected';
      if (!settings.laptopWhenInFront) return false;
      const s = store.get(sessionId);
      if (!s || s.agent === 'codex') return false; // "in front" is only tracked for Claude Desktop
      const inFront = await inFrontOnLaptop(sessionId, s.hostId, deviceFocusAt.get(sessionId) ?? 0, claudeIsFrontmost);
      return inFront ? 'open on the laptop' : false;
    },
    onEvent: syncSoon,
    onCodexStop: async (ev) => {
      if (store.answersByMessage(ev.session_id)) return; // already seen (via PreToolUse)
      const qs = await pendingCodexQuestions(ev.transcript_path, ev.turn_id);
      if (qs) {
        log('info', 'Codex asked a question; showing it on the device');
        store.setCodexQuestion(ev.session_id, qs);
      }
    },
    log,
  });
}

/** Put AgentThing's hooks into an agent's hooks file, or take them out, to match its setting. */
async function syncAgentHooks(which: 'claude' | 'codex', reason: string) {
  const inst = which === 'claude' ? claudeHooks : codexHooks;
  const on = which === 'claude' ? settings.claudeHooks : settings.codexHooks;
  const after = which === 'claude' ? 'start a new session' : 'trust them in ChatGPT → Settings → Hooks';
  try {
    if (on) {
      const r = await inst.install(settings.port);
      if (r !== 'unchanged') {
        log('info', `${inst.name} hooks ${r} (${reason}); backup saved next to the file`);
        DeskThing.send({ type: 'toast', payload: { text: `${inst.name} hooks installed — ${after}`, kind: 'ok' } });
      }
    } else if (reason === 'setting turned off') {
      if (await inst.remove()) {
        log('info', `${inst.name} hooks removed; backup saved next to the file`);
        DeskThing.send({ type: 'toast', payload: { text: `${inst.name} hooks removed`, kind: 'ok' } });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `${inst.name} hooks: ${msg}`);
    DeskThing.send({ type: 'toast', payload: { text: `Couldn’t update ${inst.name} hooks — see DeskThing’s log`, kind: 'err' } });
  }
}

/** Check the dictation key once, so a typo shows up when it's typed, not when the dial is held. */
function checkDictationKey() {
  const combo = dictationCombo();
  if (combo && 'error' in combo) {
    log('warn', `dictation key "${settings.dictationKey}": ${combo.error}`);
    DeskThing.send({ type: 'toast', payload: { text: `Dictation key: ${combo.error}`, kind: 'warn' } });
  }
}

DeskThing.on(DESKTHING_EVENTS.START, async () => {
  log('info', 'starting');
  await DeskThing.initSettings(SETTINGS);
  readSettings(await DeskThing.getSettings());
  await startHooks();
  await syncAgentHooks('claude', 'startup');
  await syncAgentHooks('codex', 'startup');
});

DeskThing.on(DESKTHING_EVENTS.SETTINGS, async (data) => {
  const before = { ...settings };
  readSettings(data.payload);
  if (before.port !== settings.port) {
    log('info', `port changed ${before.port} → ${settings.port}, restarting hook server`);
    await startHooks();
  }
  for (const which of ['claude', 'codex'] as const) {
    const key = which === 'claude' ? 'claudeHooks' : 'codexHooks';
    if (before[key] !== settings[key]) await syncAgentHooks(which, settings[key] ? 'setting turned on' : 'setting turned off');
    else if (before.port !== settings.port && settings[key]) await syncAgentHooks(which, 'port changed');
  }
  // Picking a different app fills in its usual key, unless a custom key was typed.
  if (before.dictationApp !== settings.dictationApp) {
    const prevDefault = appInfo(before.dictationApp).defaultKey;
    if (!settings.dictationKey.trim() || settings.dictationKey === prevDefault) {
      const key = appInfo(settings.dictationApp).defaultKey;
      settings.dictationKey = key;
      await DeskThing.setSettings({ dictationKey: { ...SETTINGS.dictationKey, value: key } as AppSettings[string] });
    }
  }
  if (before.dictationApp !== settings.dictationApp || before.dictationKey !== settings.dictationKey) {
    checkDictationKey();
    push(store.snapshot());
  }
});

DeskThing.on(DESKTHING_EVENTS.STOP, async () => {
  log('info', 'stopping');
  await voice.abort('app stopping');
  if (hookServer) {
    await new Promise<void>((r) => hookServer!.close(() => r()));
    hookServer = undefined;
  }
});
