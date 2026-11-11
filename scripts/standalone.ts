/**
 * Run the hook server WITHOUT DeskThing, for testing the Claude Code side on
 * its own. Prints the board to the terminal whenever it changes and accepts
 * decisions from stdin:
 *
 *   npm run standalone
 *   # in another terminal:  npm run simulate
 *   # or just use Claude Code with the hooks installed
 *
 *   a <n>   approve the n-th row   d <n>  deny   f <n>  focus on Mac   l <n>  hand to laptop
 */
import { startHookServer } from '../server/hookServer';
import { SessionStore } from '../server/sessions';
import { findDesktopSession, inFrontOnLaptop } from '../server/desktop';
import { claudeIsFrontmost, focusSession } from '../server/mac';

const port = Number(process.env.AGENTTHING_PORT || 8765);
const holdSeconds = Number(process.env.AGENTTHING_HOLD || 90);
const laptopWhenInFront = process.env.AGENTTHING_LAPTOP_WHEN_IN_FRONT === '1';

const store = new SessionStore();

function render() {
  const s = store.snapshot();
  const lines = s.sessions.map((x, i) => {
    const tag = x.status.toUpperCase().padEnd(9);
    const held = x.pending?.heldOnDevice ? '  [HELD — a/d to decide]' : x.pending ? '  [on laptop]' : '';
    const sub = x.pending?.summary || x.lastTool || x.lastMessage || x.lastPrompt || x.folder;
    return `${String(i + 1).padStart(2)}. ${tag} ${x.focused ? '●' : ' '} ${x.title}  —  ${sub}${held}`;
  });
  console.log('\n──── AgentThing board ───────────────────────────');
  console.log(lines.length ? lines.join('\n') : '(no sessions)');
  console.log('─────────────────────────────────────────────────');
}

store.onChange(render);

startHookServer(store, {
  port,
  holdMs: () => holdSeconds * 1000,
  shouldSkipHold: async (id) => {
    if (!laptopWhenInFront || process.platform !== 'darwin') return false;
    const s = store.get(id);
    return s && (await inFrontOnLaptop(id, s.hostId, 0, claudeIsFrontmost)) ? 'open on the laptop' : false;
  },
  log: (level, msg) => console.log(`[${level}] ${msg}`),
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  const [cmd, n] = chunk.trim().split(/\s+/);
  const row = store.snapshot().sessions[Number(n) - 1];
  if (!row) return console.log('no such row');
  if (cmd === 'a') console.log(store.decide(row.id, 'allow') ? 'approved' : 'nothing held');
  else if (cmd === 'd') console.log(store.decide(row.id, 'deny') ? 'denied' : 'nothing held');
  else if (cmd === 'f' || cmd === 'l') {
    store.setFocused(row.id);
    if (cmd === 'l') store.decide(row.id, 'release');
    if (process.platform === 'darwin') {
      const d = await findDesktopSession(row.id, store.get(row.id)?.hostId);
      console.log(await focusSession(d?.hostId).catch((e) => `focus failed: ${e.message}`));
    }
  }
});
render();
