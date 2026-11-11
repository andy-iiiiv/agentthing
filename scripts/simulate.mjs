#!/usr/bin/env node
/**
 * Fires a realistic sequence of fake Claude Code hook events at the hook
 * server so you can exercise the board without running Claude.
 *
 *   npm run simulate              # two sessions, one ends up needing you
 *   npm run simulate -- --port 8765 --no-wait
 *
 * The PermissionRequest at the end is held by the server until you decide
 * (dial on the Car Thing, or `a 1` in `npm run standalone`), or until the
 * hold times out. This script prints what the server answered.
 */
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 8765);
const wait = !args.includes('--no-wait');
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(ev, headers = {}) {
  const res = await fetch(`${base}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(ev),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const A = { session_id: 'sim-aaaa-1111', cwd: '/Users/you/code/shop-api' };
const B = { session_id: 'sim-bbbb-2222', cwd: '/Users/you/code/sensor-firmware' };

async function main() {
  const health = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  if (!health) {
    console.error(`No hook server on ${base}. Start DeskThing with AgentThing, or \`npm run standalone\`.`);
    process.exit(1);
  }

  console.log('→ SessionStart ×2');
  await post({ ...A, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' },
    { 'X-CC-Socket': '/tmp/cc-socks-501/sim-aaaa.sock', 'X-CC-Token': 'sim-token-a' });
  await post({ ...B, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5', session_title: 'Firmware OTA retries' });
  await sleep(600);

  console.log('→ UserPromptSubmit ×2');
  await post({ ...A, hook_event_name: 'UserPromptSubmit', prompt: 'Add order status filters to the admin page and write tests' });
  await post({ ...B, hook_event_name: 'UserPromptSubmit', prompt: 'Make the OTA updater retry on flaky networks' });
  await sleep(600);

  console.log('→ PreToolUse (A: Grep, B: Edit)');
  await post({ ...A, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'status_filter' } });
  await post({ ...B, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/Users/you/code/sensor-firmware/src/ota.ts' } });
  await sleep(900);

  console.log('→ Stop (B done)');
  await post({ ...B, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Added exponential backoff with jitter to the OTA client.\n\nTests pass.' });
  await sleep(600);

  console.log('→ PermissionRequest (A wants to run a Bash command) — server will hold it');
  const started = Date.now();
  const p = post({
    ...A,
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'npm test -- --filter orders', description: 'Run the orders test suite' },
    permission_suggestions: [],
  });
  if (!wait) {
    console.log('(not waiting for the decision; the request stays held on the server)');
    return;
  }
  console.log('   waiting for a decision on the device / standalone console…');
  const r = await p;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`   ← ${r.status} after ${secs}s:`, JSON.stringify(r.body));
  const d = r.body?.hookSpecificOutput?.decision?.behavior;
  console.log(d === 'allow' ? '   Claude would run the command.' : d === 'deny' ? '   Claude would be told no.' : '   Released: the normal laptop prompt would appear.');

  console.log('→ Stop (A done) + SessionEnd (B)');
  await post({ ...A, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Filters added and 14 tests pass.' });
  await post({ ...B, hook_event_name: 'SessionEnd', reason: 'other' });
}

main().catch((e) => { console.error(e); process.exit(1); });
