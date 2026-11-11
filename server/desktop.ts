import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Read-only view of the Claude Desktop app's Code session list.
 *
 * Desktop keeps one JSON file per Code session:
 *   ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<uuid>.json
 * with (among much else) its own id (`sessionId`, "local_…"), the Claude Code
 * id the hooks send (`cliSessionId`), the sidebar `title`, `isArchived` and
 * `lastFocusedAt`. That gives us the sidebar title for the board and the id
 * the `claude://code/continue?session=…` deep link needs.
 *
 * The files are big (mostly a cached system prompt), so each is parsed only
 * when its mtime changes.
 */

const ROOT = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

export interface DesktopSession {
  /** Desktop's id, "local_<uuid>". What the deep link takes. */
  hostId: string;
  /** Claude Code's session id: matches the hooks' session_id. Changes after /clear. */
  cliSessionId?: string;
  title?: string;
  /** e.g. "claude-opus-5-5" */
  model?: string;
  isArchived: boolean;
  lastFocusedAt: number;
  file: string;
}

interface CacheEntry { mtimeMs: number; session: DesktopSession | null }
const cache = new Map<string, CacheEntry>();

async function sessionFiles(): Promise<string[]> {
  const out: string[] = [];
  const dirs = async (p: string) =>
    (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => join(p, d.name));
  for (const account of await dirs(ROOT)) {
    for (const org of await dirs(account)) {
      const names = await readdir(org).catch(() => [] as string[]);
      for (const n of names) if (/^local_[A-Za-z0-9-]+\.json$/.test(n)) out.push(join(org, n));
    }
  }
  return out;
}

async function load(file: string): Promise<DesktopSession | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.session;
  let session: DesktopSession | null = null;
  try {
    const d = JSON.parse(await readFile(file, 'utf8'));
    if (typeof d.sessionId === 'string') {
      session = {
        hostId: d.sessionId,
        cliSessionId: typeof d.cliSessionId === 'string' ? d.cliSessionId : undefined,
        title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : undefined,
        model: typeof d.model === 'string' && d.model ? d.model : undefined,
        isArchived: d.isArchived === true,
        lastFocusedAt: typeof d.lastFocusedAt === 'number' ? d.lastFocusedAt : 0,
        file,
      };
    }
  } catch {
    // Mid-write or unexpected format: try again next time.
    return hit?.session ?? null;
  }
  cache.set(file, { mtimeMs, session });
  return session;
}

/** All Desktop Code sessions (archived included), refreshed from disk where changed. */
export async function listDesktopSessions(): Promise<DesktopSession[]> {
  const files = await sessionFiles();
  const live = new Set(files);
  for (const f of cache.keys()) if (!live.has(f)) cache.delete(f);
  const all = await Promise.all(files.map(load));
  return all.filter((s): s is DesktopSession => !!s);
}

/** Find the Desktop session for a hook session_id (or a known host id). */
export async function findDesktopSession(cliSessionId: string, hostId?: string): Promise<DesktopSession | undefined> {
  const all = await listDesktopSessions();
  return all.find((s) => (hostId && s.hostId === hostId) || s.cliSessionId === cliSessionId);
}

/** The session most recently brought to the front in Desktop (archived ones excluded). */
export async function mostRecentlyFocused(): Promise<DesktopSession | undefined> {
  const all = (await listDesktopSessions()).filter((s) => !s.isArchived);
  return all.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0];
}

/**
 * Is the user looking at this session on the laptop right now? True when
 * Claude is the front app and this is the session last brought up in it —
 * unless it was the device that brought it up, which means the user is
 * driving from the device and the request should wait there.
 */
export async function inFrontOnLaptop(
  cliSessionId: string,
  hostId: string | undefined,
  deviceFocusedAt: number,
  claudeIsFrontmost: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await claudeIsFrontmost())) return false;
  const [front, mine] = await Promise.all([mostRecentlyFocused(), findDesktopSession(cliSessionId, hostId)]);
  if (!front || !mine || front.hostId !== mine.hostId) return false;
  const DEVICE_FOCUS_SLACK_MS = 5000;
  if (deviceFocusedAt > 0 && front.lastFocusedAt - deviceFocusedAt < DEVICE_FOCUS_SLACK_MS) return false;
  return true;
}
