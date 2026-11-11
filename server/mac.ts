import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';

/**
 * macOS glue for the Claude Desktop and ChatGPT apps. Needs no Accessibility permission:
 *  - focusing uses each app's own link: claude://code/continue?session=local_<id>, codex://threads/<id>
 *  - "is it in front" uses lsappinfo
 */

const BUNDLE_ID = 'com.anthropic.claudefordesktop';
/** The ChatGPT Mac app (which hosts Codex threads) identifies as Codex. */
export const CODEX_BUNDLE_ID = 'com.openai.codex';
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Desktop's own check for the deep link's session param. Anything else is rejected before `open`. */
const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/;

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || '').trim() || err.message));
      resolve(String(stdout).trim());
    });
  });
}

/**
 * Bring a Code session up in Claude Desktop. With Desktop's id for it, opens
 * exactly that session; without one, just brings Claude forward.
 */
export async function focusSession(hostId: string | undefined): Promise<'opened' | 'activated'> {
  if (hostId && HOST_ID.test(hostId)) {
    await run('open', [`claude://code/continue?session=${hostId}`]);
    return 'opened';
  }
  await run('open', ['-b', BUNDLE_ID]);
  return 'activated';
}

/**
 * Bring a Codex thread up in the ChatGPT app, via its documented
 * codex://threads/<thread-id> link. Without a valid id, just brings the app forward.
 */
export async function focusCodexThread(threadId: string): Promise<'opened' | 'activated'> {
  if (CODEX_THREAD_ID.test(threadId)) {
    await run('open', [`codex://threads/${threadId}`]);
    return 'opened';
  }
  await run('open', ['-b', CODEX_BUNDLE_ID]);
  return 'activated';
}

/** The Codex CLI the ChatGPT app ships with (or one on PATH). */
async function codexCli(): Promise<string> {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  try {
    await access(bundled);
    return bundled;
  } catch {
    return 'codex';
  }
}

/**
 * Send a Codex thread a message, as the user: queue it with `codex queue`,
 * then ask the ChatGPT app to send queued messages for that thread
 * (codex://threads/wake/<id>), in the background so the laptop doesn't jump.
 */
export async function sendCodexMessage(threadId: string, text: string): Promise<void> {
  if (!CODEX_THREAD_ID.test(threadId)) throw new Error('not a Codex thread id');
  if (!text.trim()) throw new Error('nothing to send');
  await run(await codexCli(), ['queue', '--thread', threadId, '--message', text], 15000);
  await run('open', ['-g', `codex://threads/wake/${threadId}`]);
}

/** Is this app (by bundle id) the frontmost one? Any failure counts as no. */
export async function appIsFrontmost(bundleId: string): Promise<boolean> {
  try {
    const asn = await run('lsappinfo', ['front'], 1500);
    if (!asn) return false;
    const info = await run('lsappinfo', ['info', '-only', 'bundleid', asn], 1500);
    return info.includes(`"${bundleId}"`);
  } catch {
    return false;
  }
}

/** Is Claude Desktop the frontmost app? */
export function claudeIsFrontmost(): Promise<boolean> {
  return appIsFrontmost(BUNDLE_ID);
}
