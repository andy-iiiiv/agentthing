import { execFile } from 'node:child_process';
import type { KeyCombo } from './dictation';

/**
 * Synthetic keyboard input on the Mac, for hold-to-talk with a dictation app
 * (Rhino, Wispr Flow, Superwhisper…: anything with a hold-to-record key), plus
 * reading what it typed from the clipboard.
 *
 * Runs JavaScript for Automation (osascript -l JavaScript) calling
 * CoreGraphics, so nothing needs compiling. Posting key events needs macOS
 * Accessibility permission for the process running this server: DeskThing.
 */

function jxa(script: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || '').trim() || err.message));
      resolve(String(stdout).replace(/\n$/, ''));
    });
  });
}

/**
 * Can this process post key events? With prompt=true and no permission yet,
 * macOS shows its "allow DeskThing to control this computer" dialog.
 */
export async function accessibilityTrusted(prompt: boolean): Promise<boolean> {
  const call = prompt
    ? '$.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }))'
    : '$.AXIsProcessTrusted()';
  try {
    return (await jxa(`ObjC.import('ApplicationServices'); ${call} ? 'yes' : 'no'`)) === 'yes';
  } catch {
    return false;
  }
}

const NON_COALESCED = 0x100;

/**
 * Press (down=true) or release a dictation app's push-to-talk combo:
 * modifiers first then the key on the way down, the reverse on the way up,
 * each event carrying the modifier flags held at that moment.
 */
export async function holdDictationKey(combo: KeyCombo, down: boolean): Promise<void> {
  await jxa(dictationScript(combo, down));
}

/** The JXA script for holdDictationKey (separate so it can be checked without pressing anything). */
export function dictationScript(combo: KeyCombo, down: boolean): string {
  const post = (code: number, isDown: boolean, flags: number) =>
    `{ const e = $.CGEventCreateKeyboardEvent(null, ${code}, ${isDown}); $.CGEventSetFlags(e, ${flags | NON_COALESCED}); $.CGEventPost(0, e); delay(0.015); }`;
  const all = combo.modifiers.length ? combo.modifiers[combo.modifiers.length - 1].flags : 0;
  const steps: string[] = [];
  if (down) {
    for (const m of combo.modifiers) steps.push(post(m.code, true, m.flags));
    if (combo.key !== undefined) steps.push(post(combo.key, true, all));
  } else {
    if (combo.key !== undefined) steps.push(post(combo.key, false, all));
    for (let i = combo.modifiers.length - 1; i >= 0; i--) {
      steps.push(post(combo.modifiers[i].code, false, i > 0 ? combo.modifiers[i - 1].flags : 0));
    }
  }
  return `ObjC.import('CoreGraphics'); ${steps.join('\n')} 'ok'`;
}

const KEY_RETURN = 36;

/** Tap Return in the front app. */
export async function pressReturn(): Promise<void> {
  await jxa(`ObjC.import('CoreGraphics');
for (const down of [true, false]) {
  const e = $.CGEventCreateKeyboardEvent(null, ${KEY_RETURN}, down);
  $.CGEventSetFlags(e, 0);
  $.CGEventPost(0, e);
  delay(0.02);
} 'ok'`);
}

/**
 * Wait for the clipboard to change and return the new text, or '' if it
 * doesn't change within the window. Dictation apps paste by briefly putting
 * the text on the clipboard, so the first change after you stop talking is
 * what was typed. Nothing is logged or kept beyond the reply to the device.
 */
export async function nextClipboardText(windowMs: number): Promise<string> {
  const seconds = Math.max(1, windowMs / 1000);
  try {
    return await jxa(
      `ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const start = pb.changeCount;
const until = Date.now() + ${Math.round(seconds * 1000)};
let out = '';
while (Date.now() < until) {
  if (pb.changeCount !== start) {
    delay(0.03);
    const s = pb.stringForType($.NSPasteboardTypeString);
    out = (s && !s.isNil()) ? s.js : '';
    break;
  }
  delay(0.04);
}
out`,
      windowMs + 3000,
    );
  } catch {
    return '';
  }
}
