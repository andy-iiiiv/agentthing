/**
 * Which Mac dictation app hold-to-talk drives, and the key combo it records
 * on while held (its push-to-talk shortcut). Both are AgentThing settings;
 * picking an app fills in that app's usual key, and the key stays editable.
 */

export type DictationApp = 'rhino' | 'wispr' | 'superwhisper' | 'other' | 'off';

export const DICTATION_APPS: { value: DictationApp; label: string; defaultKey: string }[] = [
  { value: 'rhino', label: 'Rhino', defaultKey: 'right cmd' },
  { value: 'wispr', label: 'Wispr Flow', defaultKey: 'fn' },
  { value: 'superwhisper', label: 'Superwhisper', defaultKey: 'option+space' },
  { value: 'other', label: 'Another app (set its key below)', defaultKey: 'right option' },
  { value: 'off', label: 'Off', defaultKey: '' },
];

export function appInfo(app: string) {
  return DICTATION_APPS.find((a) => a.value === app) ?? DICTATION_APPS[0];
}

/** A key combo ready to press: modifiers in order, then an optional ordinary key. */
export interface KeyCombo {
  modifiers: { code: number; flags: number }[];
  key?: number;
  /** Tidy display form, e.g. "Right ⌘", "⌥ Space", "⌃⇧D". */
  label: string;
}

type Side = 'left' | 'right';
type ModName = 'cmd' | 'opt' | 'ctrl' | 'shift' | 'fn';

// Key codes and CGEventFlags (mask | left/right device bit) for each modifier.
const MODS: Record<ModName, { mask: number; symbol: string; left: [number, number]; right?: [number, number] }> = {
  cmd: { mask: 0x100000, symbol: '⌘', left: [55, 0x08], right: [54, 0x10] },
  opt: { mask: 0x80000, symbol: '⌥', left: [58, 0x20], right: [61, 0x40] },
  ctrl: { mask: 0x40000, symbol: '⌃', left: [59, 0x01], right: [62, 0x2000] },
  shift: { mask: 0x20000, symbol: '⇧', left: [56, 0x02], right: [60, 0x04] },
  fn: { mask: 0x800000, symbol: 'fn', left: [63, 0] },
};

const MOD_ALIASES: Record<string, ModName> = {
  cmd: 'cmd', command: 'cmd', '⌘': 'cmd', meta: 'cmd',
  opt: 'opt', option: 'opt', alt: 'opt', '⌥': 'opt',
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', '⌃': 'ctrl',
  shift: 'shift', '⇧': 'shift',
  fn: 'fn', function: 'fn', globe: 'fn', '🌐': 'fn',
};

// macOS virtual key codes (ANSI layout).
const KEYS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  space: 49, return: 36, enter: 36, tab: 48, escape: 53, esc: 53, delete: 51, backspace: 51,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

const SIDE_WORDS: Record<string, Side> = { right: 'right', r: 'right', left: 'left', l: 'left' };

/**
 * Parse "right cmd", "fn", "option+space", "⌥ Space", "ctrl+shift+d", "rcmd"…
 * Modifiers alone are fine (held as-is); at most one ordinary key.
 */
export function parseKeyCombo(input: string): KeyCombo | { error: string } {
  const text = input.trim().toLowerCase().replace(/[⌘⌥⌃⇧🌐]/g, (m) => ` ${m} `);
  if (!text) return { error: 'No key set' };
  const raw = text.split(/[\s+_]+/).filter(Boolean);

  const modifiers: KeyCombo['modifiers'] = [];
  const labels: string[] = [];
  let key: number | undefined;
  let keyLabel = '';
  let side: Side | null = null;
  let flags = 0;

  for (let tok of raw) {
    // "rcmd", "lshift", "ropt"
    const glued = /^([rl])(cmd|command|opt|option|alt|ctrl|control|shift)$/.exec(tok);
    if (glued) {
      side = glued[1] === 'r' ? 'right' : 'left';
      tok = glued[2];
    }
    if (SIDE_WORDS[tok] && !glued) {
      side = SIDE_WORDS[tok];
      continue;
    }
    const mod = MOD_ALIASES[tok];
    if (mod) {
      const m = MODS[mod];
      const useRight = side === 'right' && m.right;
      if (side === 'right' && !m.right) return { error: `There's no right ${tok} key` };
      const [code, device] = useRight ? m.right! : m.left;
      flags |= m.mask | device;
      modifiers.push({ code, flags });
      labels.push(mod === 'fn' ? 'Fn' : `${useRight ? 'Right ' : ''}${m.symbol}`);
      side = null;
      continue;
    }
    if (side) return { error: `"${side}" goes before a modifier (cmd, option, control, shift)` };
    if (KEYS[tok] === undefined) return { error: `Unknown key "${tok}"` };
    if (key !== undefined) return { error: 'Only one key besides modifiers' };
    key = KEYS[tok];
    keyLabel = tok.length === 1 ? tok.toUpperCase() : tok[0].toUpperCase() + tok.slice(1);
  }
  if (side) return { error: `"${side}" needs a modifier after it` };
  if (modifiers.length === 0 && key === undefined) return { error: 'No key set' };

  const modLabel = labels.join(labels.some((l) => l.length > 1) ? ' + ' : '');
  const label = [modLabel, keyLabel].filter(Boolean).join(modLabel && keyLabel ? ' ' : '');
  return { modifiers, key, label };
}
