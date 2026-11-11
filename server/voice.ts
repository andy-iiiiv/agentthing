import type { VoiceState } from '../shared/protocol';
import type { KeyCombo } from './dictation';
import { accessibilityTrusted, holdDictationKey, nextClipboardText, pressReturn } from './keys';

/**
 * Hold-to-talk through the user's Mac dictation app (Rhino, Wispr Flow,
 * Superwhisper…), by holding its push-to-talk key. The words land in Claude's
 * prompt box as the user's own:
 *
 *   dial held     → bring the session up in Claude, hold the dictation key (app listens)
 *   dial released → let go of the key (app types), read what it typed
 *   dial pressed  → Return in Claude (send)
 *
 * One dictation at a time. The key is never left held: it's let go on stop,
 * on abort (device gone, app stopping) and after MAX_HOLD_MS regardless.
 */

interface Deps {
  /** The dictation app's push-to-talk combo, null when hold-to-talk is off, or why the key can't be used. */
  dictationKey: () => KeyCombo | { error: string } | null;
  /** Bring the session up in its app (Claude Desktop or ChatGPT). False if the session is gone. */
  focus: (sessionId: string) => Promise<boolean>;
  /** Is the session's app the front app on the Mac? */
  isFront: (sessionId: string) => Promise<boolean>;
  emit: (v: VoiceState) => void;
  toast: (text: string, kind: 'ok' | 'warn' | 'err') => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Time for Desktop to switch to the session and put the cursor in its prompt box. */
const SETTLE_MS = 600;
const MAX_HOLD_MS = 120_000;
/** How long to wait for the dictation app to transcribe and type after you let go. */
const TYPE_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Voice {
  private state: VoiceState = { sessionId: '', phase: 'idle' };
  /** The key we're holding down right now, if any. */
  private keyHeld: KeyCombo | null = null;
  private stopRequested = false;
  private watchdog?: NodeJS.Timeout;

  constructor(private d: Deps) {}

  current(): VoiceState {
    return this.state;
  }

  private set(next: VoiceState) {
    this.state = next;
    this.d.emit(next);
  }

  async start(sessionId: string) {
    const p = this.state.phase;
    if (p === 'starting' || p === 'listening' || p === 'typing') return;
    const key = this.d.dictationKey();
    if (!key) {
      this.d.toast('Hold to talk is off — pick a dictation app in AgentThing’s settings', 'warn');
      return;
    }
    if ('error' in key) {
      this.d.toast(`Dictation key: ${key.error}`, 'warn');
      return;
    }
    this.stopRequested = false;
    this.set({ sessionId, phase: 'starting' });

    if (!(await accessibilityTrusted(true))) {
      this.d.toast('Allow DeskThing in Settings → Privacy → Accessibility', 'err');
      this.d.log('warn', 'voice: DeskThing has no Accessibility permission (macOS should be asking for it)');
      this.set({ sessionId, phase: 'idle' });
      return;
    }
    if (!(await this.d.focus(sessionId))) {
      this.set({ sessionId, phase: 'idle' });
      return;
    }
    await sleep(SETTLE_MS);
    if (this.stopRequested) {
      // Let go before we started listening: nothing to do.
      this.set({ sessionId, phase: 'idle' });
      return;
    }
    try {
      await holdDictationKey(key, true);
      this.keyHeld = key;
    } catch (e) {
      this.d.log('error', `voice: couldn't press the dictation key: ${e instanceof Error ? e.message : String(e)}`);
      this.d.toast('Couldn’t start dictation', 'err');
      this.set({ sessionId, phase: 'idle' });
      return;
    }
    this.set({ sessionId, phase: 'listening' });
    this.watchdog = setTimeout(() => {
      this.d.log('warn', 'voice: held for too long, stopping');
      void this.stop();
    }, MAX_HOLD_MS);
    this.watchdog.unref?.();
  }

  async stop() {
    if (this.state.phase === 'starting') {
      this.stopRequested = true;
      return;
    }
    if (this.state.phase !== 'listening') return;
    const sessionId = this.state.sessionId;
    if (this.watchdog) clearTimeout(this.watchdog);
    // Start watching the clipboard before letting go, so the app's paste can't slip past.
    const typed = nextClipboardText(TYPE_WAIT_MS);
    await this.releaseKey();
    this.set({ sessionId, phase: 'typing' });
    const text = (await typed).trim();
    const now = this.current();
    if (now.sessionId !== sessionId || now.phase !== 'typing') return; // cancelled meanwhile
    this.set({ sessionId, phase: 'ready', text: text || undefined });
  }

  async send(sessionId: string) {
    if (this.state.phase !== 'ready' || this.state.sessionId !== sessionId) return;
    if (!(await this.d.isFront(sessionId))) {
      if (!(await this.d.focus(sessionId))) return;
      await sleep(SETTLE_MS);
    }
    try {
      await pressReturn();
      this.d.toast('Sent', 'ok');
    } catch (e) {
      this.d.log('error', `voice: couldn't press Return: ${e instanceof Error ? e.message : String(e)}`);
      this.d.toast('Couldn’t send — press Return on the laptop', 'err');
    }
    this.set({ sessionId, phase: 'idle' });
  }

  /**
   * "Edit on computer": don't send; the text is already in the session's
   * prompt box, so bring the session up on the laptop to fix and send by hand.
   */
  async edit(sessionId: string) {
    const p = this.state.phase;
    if (this.state.sessionId !== sessionId || (p !== 'ready' && p !== 'typing')) return;
    this.set({ sessionId, phase: 'idle' });
    if (await this.d.focus(sessionId)) this.d.toast('It’s in the prompt box — edit and send there', 'ok');
  }

  /** Done with this dictation without sending; the text stays in Claude's prompt box. */
  cancel(sessionId: string) {
    const p = this.state.phase;
    if (this.state.sessionId === sessionId && (p === 'ready' || p === 'typing')) this.set({ sessionId, phase: 'idle' });
  }

  /** Stop everything now (device gone, app stopping). */
  async abort(reason: string) {
    if (this.state.phase === 'idle') return;
    this.d.log('info', `voice: stopped (${reason})`);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.stopRequested = true;
    await this.releaseKey();
    this.set({ sessionId: this.state.sessionId, phase: 'idle' });
  }

  private async releaseKey() {
    const key = this.keyHeld;
    if (!key) return;
    this.keyHeld = null;
    try {
      await holdDictationKey(key, false);
    } catch (e) {
      this.d.log('error', `voice: couldn't release the dictation key: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
