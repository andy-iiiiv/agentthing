import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Installs AgentThing's hooks into an agent's hooks file, or takes them out,
 * for the "Install Claude Code hooks" / "Install Codex hooks" settings.
 *
 * Both files share one shape: { hooks: { <Event>: [ { matcher?, hooks: [ {type:'command', command, timeout, async?} ] } ] } }.
 * Only entries recognised as AgentThing's are touched; everything else is
 * kept. The file is backed up before every change. Each hook pipes the event
 * to the local server with curl, and ends in `# agentthing` so it can be
 * found again. `|| true` keeps the hooks quiet when DeskThing isn't running.
 */

const MARK = '# agentthing';

/** Claude Code gives the PermissionRequest hook up to this long; requests wait on the device inside it. */
export const PERMISSION_HOOK_TIMEOUT_S = 150;

interface EventSpec {
  event: string;
  timeout: number;
  /** Codex: run in the background (can't decide anything; output is discarded). */
  async?: boolean;
  /** The hook's reply decides something (PermissionRequest), so keep stdout. */
  decides?: boolean;
}

interface Target {
  /** For log lines and toasts. */
  name: string;
  path: string;
  /** Extra query string on the hook URL, telling the server which agent sent it. */
  query: string;
  events: EventSpec[];
  /** Also treat these (older, unmarked) entries as ours. */
  legacy?: (command: string) => boolean;
}

interface HookEntry { type?: string; command?: string; [k: string]: unknown }
interface MatcherGroup { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown }
type HooksFile = { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown };

function hookCommand(t: Target, port: number, e: EventSpec): string {
  const curlMax = Math.max(1, e.timeout - (e.timeout > 10 ? 5 : 1));
  const url = `http://127.0.0.1:${port}/hook${t.query}`;
  // Only a deciding hook's reply should reach the agent; Codex feeds other hooks' output to the model.
  const quiet = e.decides ? '' : ' >/dev/null 2>&1';
  return `curl -s -m ${curlMax} -X POST '${url}' -H 'content-type: application/json' --data-binary @-${quiet} || true ${MARK}`;
}

function entry(t: Target, port: number, e: EventSpec): HookEntry {
  const h: HookEntry = { type: 'command', command: hookCommand(t, port, e), timeout: e.timeout };
  if (e.async) h.async = true;
  return h;
}

function isOurs(t: Target, h: HookEntry): boolean {
  const c = typeof h.command === 'string' ? h.command : '';
  return c.includes(MARK) || !!t.legacy?.(c);
}

async function load(t: Target): Promise<HooksFile> {
  let text: string;
  try {
    text = await readFile(t.path, 'utf8');
  } catch {
    return {}; // no file yet
  }
  if (!text.trim()) return {};
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an object');
    return d as HooksFile;
  } catch {
    throw new Error(`${t.path.replace(homedir(), '~')} isn’t valid JSON, so AgentThing left it alone`);
  }
}

async function save(t: Target, next: HooksFile) {
  await mkdir(dirname(t.path), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await copyFile(t.path, `${t.path}.agentthing-${stamp}.bak`);
  } catch {
    // nothing to back up yet
  }
  const tmp = `${t.path}.agentthing-tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, t.path);
}

/** The file with every AgentThing hook taken out (empty groups and events dropped). */
function without(t: Target, d: HooksFile): HooksFile {
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(d.hooks || {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(t, h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const out: HooksFile = { ...d, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

function withOurs(t: Target, d: HooksFile, port: number): HooksFile {
  const base = without(t, d);
  const hooks = { ...(base.hooks || {}) };
  for (const e of t.events) hooks[e.event] = [...(hooks[e.event] || []), { hooks: [entry(t, port, e)] }];
  return { ...base, hooks };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function installer(t: Target) {
  return {
    name: t.name,
    /** Make sure AgentThing's hooks are in place for this port. */
    async install(port: number): Promise<'installed' | 'updated' | 'unchanged'> {
      const d = await load(t);
      const next = withOurs(t, d, port);
      if (same(d, next)) return 'unchanged';
      const had = !same(without(t, d), d);
      await save(t, next);
      return had ? 'updated' : 'installed';
    },
    /** Take AgentThing's hooks out. Returns whether anything was removed. */
    async remove(): Promise<boolean> {
      const d = await load(t);
      const next = without(t, d);
      if (same(d, next)) return false;
      await save(t, next);
      return true;
    },
    /** The hooks block as JSON, for adding by hand. */
    snippet(port: number): string {
      return JSON.stringify(withOurs(t, {}, port), null, 2);
    },
  };
}

/** Claude Code (Desktop and CLI): ~/.claude/settings.json. Desktop doesn't run `http` hooks, hence curl. */
export const claudeHooks = installer({
  name: 'Claude Code',
  path: join(homedir(), '.claude', 'settings.json'),
  query: '',
  events: [
    { event: 'SessionStart', timeout: 5 },
    { event: 'SessionEnd', timeout: 2 },
    { event: 'UserPromptSubmit', timeout: 5 },
    { event: 'PreToolUse', timeout: 5 },
    { event: 'Stop', timeout: 5 },
    { event: 'Notification', timeout: 5 },
    { event: 'PermissionRequest', timeout: PERMISSION_HOOK_TIMEOUT_S, decides: true },
  ],
  // The hand-installed form from AgentThing 0.1–0.5.
  legacy: (c) => c.includes('127.0.0.1:') && c.includes('/hook') && c.includes('X-CC-Socket'),
});

/**
 * Codex (the ChatGPT app's Codex threads, and the Codex CLI): ~/.codex/hooks.json.
 * Codex skips new or changed hooks until the user trusts them in Settings → Hooks.
 * SessionEnd and Interrupt hooks are capped at 3 s and always run in the foreground.
 */
export const codexHooks = installer({
  name: 'Codex',
  path: join(homedir(), '.codex', 'hooks.json'),
  query: '?agent=codex',
  // AgentThing's old Claude Code hooks, if the ChatGPT app copied them over from ~/.claude/settings.json.
  legacy: (c) => c.includes('127.0.0.1:') && c.includes('/hook') && c.includes('X-CC-Socket'),
  events: [
    { event: 'SessionStart', timeout: 10, async: true },
    { event: 'UserPromptSubmit', timeout: 10, async: true },
    { event: 'PreToolUse', timeout: 10, async: true },
    { event: 'Stop', timeout: 10, async: true },
    { event: 'Interrupt', timeout: 2 },
    { event: 'SessionEnd', timeout: 2 },
    { event: 'PermissionRequest', timeout: PERMISSION_HOOK_TIMEOUT_S, decides: true },
  ],
});
