import { useCallback, useEffect, useRef, useState } from 'react';
import { createDeskThing } from '@deskthing/client';
import type { Answers, BoardState, CmdRequest, ToClient, ToServer, VoiceState } from '../shared/protocol';
import { APP_VERSION } from '../shared/version';
import { OVERRIDE_KEYS } from './controls';
import { startMockBoard } from './mock';

export const deskthing = createDeskThing<ToClient, ToServer>();

/** `?mock` in the URL: fake sessions and no DeskThing, for working on the UI in a desktop browser. */
export const MOCK = typeof location !== 'undefined' && /[?&]mock\b/.test(location.search);

const EMPTY: BoardState = {
  sessions: [],
  focusedId: null,
  serverTime: 0,
  hookServer: { port: 0, listening: false },
};

export interface Toast { text: string; kind: 'ok' | 'warn' | 'err'; id: number }

type Input = Extract<ToServer, { type: 'debug' }>['payload'];
const MAX_LOGGED_INPUTS = 20;

/** Subscribes to board state from the server and exposes a tiny command API. */
export function useBoard() {
  const [state, setState] = useState<BoardState>(EMPTY);
  const [toast, setToast] = useState<Toast | null>(null);
  const [voice, setVoice] = useState<VoiceState>({ sessionId: '', phase: 'idle' });
  /**
   * Server clock minus device clock. The Car Thing's clock is often far off,
   * so "how long in this state" is computed in server time.
   */
  const [clockOffset, setClockOffset] = useState(0);
  const toastTimer = useRef<number | null>(null);
  const seenToastAt = useRef<number>(0);
  const mockCmd = useRef<((r: CmdRequest | 'answer', id: string, answers?: Answers) => void) | null>(null);
  const inputsLogged = useRef(0);

  const showToast = useCallback((text: string, kind: Toast['kind']) => {
    setToast({ text, kind, id: Date.now() });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => {
    const onState = (s: BoardState) => {
      if (s.appVersion && s.appVersion !== APP_VERSION && reloadForUpdate(s.appVersion)) return;
      setState(s);
      if (s.serverTime) setClockOffset(s.serverTime - Date.now());
      if (s.toast && s.toast.at !== seenToastAt.current) {
        seenToastAt.current = s.toast.at;
        // Ignore stale toasts (e.g. "Listening on :8765" from hours ago) on first load.
        if (s.serverTime - s.toast.at < 5000) showToast(s.toast.text, s.toast.kind);
      }
    };

    if (MOCK) {
      const mock = startMockBoard(onState, showToast, setVoice);
      mockCmd.current = mock.cmd;
      return mock.stop;
    }

    deskthing.overrideKeys(OVERRIDE_KEYS);
    const offState = deskthing.on('state', (msg) => onState(msg.payload as BoardState));
    const offVoice = deskthing.on('voice', (msg) => setVoice(msg.payload as VoiceState));
    const offToast = deskthing.on('toast', (msg) => {
      const p = msg.payload as { text: string; kind: Toast['kind'] };
      showToast(p.text, p.kind);
    });
    deskthing.send({ type: 'board', request: 'get' });
    // Re-ask every 5s: a safety net for missed pushes, and the server's sign the device is here
    // (after 15s of silence it moves anything waiting on the device to the laptop).
    const poll = window.setInterval(() => deskthing.send({ type: 'board', request: 'get' }), 5000);
    return () => {
      offState();
      offVoice();
      offToast();
      window.clearInterval(poll);
      deskthing.restoreKeys(OVERRIDE_KEYS);
    };
  }, [showToast]);

  const cmd = useCallback((request: CmdRequest, sessionId: string) => {
    if (mockCmd.current) return mockCmd.current(request, sessionId);
    deskthing.send({ type: 'cmd', request, payload: { sessionId } });
  }, []);

  const answer = useCallback((sessionId: string, answers: Answers) => {
    if (mockCmd.current) return mockCmd.current('answer', sessionId, answers);
    deskthing.send({ type: 'cmd', request: 'answer', payload: { sessionId, answers } });
  }, []);

  /** Report the first few hardware inputs to the server log, to check key codes on a real unit. */
  const logInput = useCallback((payload: Input) => {
    if (MOCK || inputsLogged.current >= MAX_LOGGED_INPUTS) return;
    inputsLogged.current += 1;
    deskthing.send({ type: 'debug', request: 'input', payload });
  }, []);

  return { state, toast, cmd, answer, voice, showToast, clockOffset, logInput };
}

/**
 * DeskThing installed a new version but the Car Thing still has the old page
 * open. Reload, at most once per version (in case the device serves a cached
 * page), with the version in the URL to get past the browser cache.
 */
function reloadForUpdate(version: string): boolean {
  const key = 'agentthing:reloadedFor';
  try {
    if (sessionStorage.getItem(key) === version) return false;
    sessionStorage.setItem(key, version);
  } catch {
    return false; // can't remember we tried: don't risk a reload loop
  }
  location.replace(`${location.pathname}?v=${encodeURIComponent(version)}`);
  return true;
}

/** "2m", "35s", "1h 04m", "3d" */
export function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}
