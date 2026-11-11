/**
 * Car Thing hardware → app intent.
 *
 * Inside the app, the dial arrives as wheel events and the dial press / back
 * button as key events. We claim those with overrideKeys() so DeskThing
 * doesn't also act on them.
 *
 * The four top buttons (Digit1–4) and M are left to DeskThing: its own page
 * uses them to switch apps, so the app can't rely on them.
 */
export const KEYS = {
  select: 'Enter', // dial press
  back: 'Escape', // back button
} as const;

/** Codes we take over from DeskThing while this app is open. */
export const OVERRIDE_KEYS = ['wheel', KEYS.select, KEYS.back];

export type Intent = 'prev' | 'next' | 'select' | 'back';

export function intentForKey(code: string): Intent | null {
  switch (code) {
    case KEYS.select:
    case 'Space':
      return 'select';
    case KEYS.back:
    case 'Backspace':
      return 'back';
    // Handy when testing in a desktop browser.
    case 'ArrowUp':
    case 'ArrowLeft':
      return 'prev';
    case 'ArrowDown':
    case 'ArrowRight':
      return 'next';
    default:
      return null;
  }
}

/**
 * The Car Thing dial scrolls sideways (deltaX); mice and trackpads scroll
 * vertically. Take whichever axis moved more. Positive = clockwise = next.
 */
export function wheelDirection(e: WheelEvent): 1 | -1 | 0 {
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

/** One dial detent is one wheel event; trackpads fire dozens. Ignore events closer than this. */
export const WHEEL_MIN_INTERVAL_MS = 45;
