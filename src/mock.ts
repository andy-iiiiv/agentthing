/**
 * Fake board for `?mock`: lets the UI be designed in a desktop browser
 * without DeskThing or Claude running. Not used on the device.
 */
import type { Answers, BoardState, CmdRequest, SessionView, VoiceState } from '../shared/protocol';
import { STATUS_RANK } from '../shared/protocol';

type ToastFn = (text: string, kind: 'ok' | 'warn' | 'err') => void;

export function startMockBoard(onState: (s: BoardState) => void, toast: ToastFn, onVoice: (v: VoiceState) => void) {
  const now = Date.now();
  const base = { focused: false, updatedAt: now, agent: 'claude' as const };
  let focusedId: string | null = null;
  let sessions: SessionView[] = [
    {
      ...base,
      id: 'a',
      title: 'Order status filters',
      cwd: '/Users/you/code/shop-api',
      folder: 'shop-api',
      status: 'needs_you',
      statusSince: now - 42_000,
      model: 'Opus 5.5',
      lastPrompt: 'Add order status filters to the admin page and write tests',
      pending: {
        kind: 'tool',
        toolName: 'Bash',
        summary: 'Bash: npm test -- --filter orders',
        detail: 'npm test -- --filter orders && npm run lint -- src/admin',
        heldOnDevice: true,
        since: now - 42_000,
      },
    },
    {
      ...base,
      id: 'q',
      title: 'Settings page redesign',
      cwd: '/Users/you/code/agentthing',
      folder: 'agentthing',
      status: 'needs_you',
      statusSince: now - 12_000,
      model: 'Opus 5.5',
      pending: {
        kind: 'question',
        toolName: 'AskUserQuestion',
        summary: 'Question: On the AgentThing board, when you turn the dial clockwise, which way does the highlight move?',
        heldOnDevice: true,
        since: now - 12_000,
        questions: [
          {
            question: 'On the AgentThing board, when you turn the dial clockwise, which way does the highlight move?',
            header: 'Dial',
            multiSelect: false,
            options: [
              { label: 'Down the list', description: 'Clockwise moves to the next session (what I set it to).' },
              { label: 'Up the list', description: "It's backwards; I'll flip the direction." },
              { label: "It doesn't move", description: 'Turning the dial does nothing in the app.' },
            ],
          },
          {
            question: 'Which screens should get a darker background?',
            header: 'Screens',
            multiSelect: true,
            options: [
              { label: 'Board', description: 'The session list' },
              { label: 'Card', description: 'One session, opened' },
              { label: 'Questions' },
            ],
          },
        ],
      },
    },
    {
      ...base,
      agent: 'codex',
      id: 'x',
      title: 'Migrate login to OAuth',
      cwd: '/Users/you/code/shop-api',
      folder: 'shop-api',
      status: 'running',
      statusSince: now - 75_000,
      model: 'GPT-5.5',
      lastPrompt: 'Move the login flow to OAuth and keep the old sessions working',
      lastTool: 'Shell: pnpm test auth',
    },
    {
      ...base,
      id: 'b',
      title: 'Docs site refresh',
      cwd: '/Users/you/code/docs-site',
      folder: 'docs-site',
      status: 'running',
      statusSince: now - 185_000,
      model: 'Opus 5.5',
      lastPrompt: 'Tighten the spacing on the docs landing page',
      lastTool: 'Edit: src/index.css',
    },
    {
      ...base,
      id: 'c',
      title: 'Firmware OTA retries',
      cwd: '/Users/you/code/sensor-firmware',
      folder: 'sensor-firmware',
      status: 'idle',
      statusSince: now - 9 * 60_000,
      model: 'Sonnet 5.5',
      lastPrompt: 'Make the OTA updater retry on flaky networks',
      lastMessage:
        'Added exponential backoff with jitter to the OTA client.\nTests pass (14 new). The retry cap is 6 attempts; change MAX_RETRIES in ota.ts if you want more.',
    },
    {
      ...base,
      id: 'd',
      title: 'Q3 roadmap draft',
      cwd: '/Users/you/notes/roadmap',
      folder: 'roadmap',
      status: 'idle',
      statusSince: now - 3 * 3600_000 - 12 * 60_000,
      lastMessage: 'The draft is in ROADMAP.md: three themes, with owners and dates.',
    },
  ];

  const emit = () => {
    const sorted = [...sessions]
      .map((s) => ({ ...s, focused: s.id === focusedId }))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.statusSince - a.statusSince);
    onState({
      sessions: sorted,
      focusedId,
      serverTime: Date.now(),
      hookServer: { port: 8765, listening: true },
      dictation: { enabled: true, app: 'Rhino', key: 'Right ⌘' },
    });
  };

  const update = (id: string, patch: Partial<SessionView>) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
  };

  const cmd = (request: CmdRequest | 'answer', id: string, answers?: Answers) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    switch (request) {
      case 'voice-start':
        onVoice({ sessionId: id, phase: 'starting' });
        window.setTimeout(() => onVoice({ sessionId: id, phase: 'listening' }), 500);
        return;
      case 'voice-stop':
        onVoice({ sessionId: id, phase: 'typing' });
        window.setTimeout(() => onVoice({ sessionId: id, phase: 'ready', text: 'Make the edge glow a little softer and add a setting to turn it off.' }), 1200);
        return;
      case 'voice-send':
        onVoice({ sessionId: id, phase: 'idle' });
        update(id, { status: 'running', statusSince: Date.now(), lastPrompt: 'Make the edge glow a little softer and add a setting to turn it off.' });
        toast('Sent', 'ok');
        break;
      case 'voice-edit':
        focusedId = id;
        onVoice({ sessionId: id, phase: 'idle' });
        toast('It’s in the prompt box — edit and send there', 'ok');
        break;
      case 'voice-cancel':
        onVoice({ sessionId: id, phase: 'idle' });
        return;
      case 'answer':
        (window as unknown as { lastAnswers?: Answers }).lastAnswers = answers;
        update(id, { pending: undefined, status: 'running', statusSince: Date.now() });
        toast('Answered', 'ok');
        break;
      case 'focus':
        focusedId = id;
        break;
      case 'approve':
      case 'deny':
        if (!s.pending?.heldOnDevice) return toast('Nothing waiting — answer it on the laptop', 'warn');
        update(id, { pending: undefined, status: 'running', statusSince: Date.now(), lastTool: s.pending.summary });
        toast(request === 'approve' ? 'Approved' : 'Denied', 'ok');
        break;
      case 'release':
        focusedId = id;
        if (s.pending) update(id, { pending: { ...s.pending, heldOnDevice: false } });
        break;
    }
    emit();
  };

  emit();
  // A second request shows up a little later, to check it doesn't steal the selection.
  // A running session finishes (green glow), then a new question arrives (amber).
  const done = window.setTimeout(() => {
    update('b', { status: 'idle', statusSince: Date.now(), lastMessage: 'Landing page spacing is fixed and the build passes.' });
    emit();
  }, 8_000);
  const later = window.setTimeout(() => {
    update('c', {
      status: 'needs_you',
      statusSince: Date.now(),
      pending: {
        kind: 'tool',
        toolName: 'Edit',
        summary: 'Edit: src/ota.ts',
        detail: '/Users/you/code/sensor-firmware/src/ota.ts',
        heldOnDevice: true,
        since: Date.now(),
      },
    });
    emit();
  }, 20_000);

  return { cmd, stop: () => { window.clearTimeout(done); window.clearTimeout(later); } };
}
