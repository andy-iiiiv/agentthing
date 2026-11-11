import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, Answers, CmdRequest, Question, SessionStatus, SessionView, VoiceState } from '../shared/protocol';
import { intentForKey, wheelDirection, WHEEL_MIN_INTERVAL_MS, type Intent } from './controls';
import { elapsed, useBoard } from './useBoard';

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
/** The Mac app a session's prompt box lives in. */
const AGENT_APP: Record<AgentKind, string> = { claude: 'Claude', codex: 'ChatGPT' };

const STATUS_LABEL: Record<SessionStatus, string> = {
  needs_you: 'Needs you',
  running: 'Running',
  idle: 'Done',
  ended: 'Ended',
};

/**
 * After a card opens (or its choices change), ignore dial presses this long,
 * so a quick double press can't approve or answer something you haven't read.
 */
const ARM_DELAY_MS = 700;

/** Holding the dial this long starts hold-to-talk instead of a press. */
const HOLD_TO_TALK_MS = 450;

type View = { kind: 'board' } | { kind: 'card'; id: string };
type Tone = 'approve' | 'deny' | 'neutral';

/** Something on a card the dial can land on. */
type Item =
  | { kind: 'action'; id: CmdRequest; label: string; tone: Tone }
  | { kind: 'option'; index: number; label: string; description?: string; checked?: boolean }
  | { kind: 'done'; label: string; disabled: boolean }
  | { kind: 'laptop'; label: string };

/** How long the edge glow stays up after a change. */
const GLOW_MS = 5000;
type GlowColor = 'amber' | 'green';

/**
 * What changed between two board states, as a glow color: amber when a
 * session newly needs you (a new request or question), green when a running
 * session finishes. Amber wins if both happen at once.
 */
function glowFor(prev: Map<string, { status: SessionStatus; since?: number }>, sessions: SessionView[]): GlowColor | null {
  let color: GlowColor | null = null;
  for (const s of sessions) {
    const p = prev.get(s.id);
    if (s.status === 'needs_you' && (!p || p.status !== 'needs_you' || p.since !== s.pending?.since)) return 'amber';
    if (s.status === 'idle' && p?.status === 'running') color = 'green';
  }
  return color;
}

/** Progress through a held AskUserQuestion. */
interface QaState { qIndex: number; answers: Answers; picked: number[] }
const QA_START: QaState = { qIndex: 0, answers: {}, picked: [] };

/** The questions to answer on the device, if this card is showing a held question. */
function heldQuestions(s?: SessionView): Question[] | undefined {
  const p = s?.pending;
  return p && p.kind === 'question' && p.heldOnDevice && p.questions?.length ? p.questions : undefined;
}

function itemsFor(s: SessionView, qa: QaState, voice?: VoiceState): Item[] {
  if (voice) {
    return voice.phase === 'ready'
      ? [
          { kind: 'action', id: 'voice-send', label: 'Send', tone: 'approve' },
          { kind: 'action', id: 'voice-edit', label: 'Edit on computer', tone: 'neutral' },
        ]
      : [];
  }
  const qs = heldQuestions(s);
  if (qs) {
    const q = qs[Math.min(qa.qIndex, qs.length - 1)];
    const items: Item[] = q.options.map((o, i) => ({
      kind: 'option',
      index: i,
      label: o.label,
      description: o.description,
      checked: q.multiSelect ? qa.picked.includes(i) : undefined,
    }));
    if (q.multiSelect) {
      items.push({ kind: 'done', label: qa.qIndex < qs.length - 1 ? 'Next' : 'Done', disabled: qa.picked.length === 0 });
    }
    items.push({ kind: 'laptop', label: 'Answer on laptop' });
    return items;
  }
  if (s.pending?.heldOnDevice) {
    return [
      { kind: 'action', id: 'approve', label: 'Approve', tone: 'approve' },
      { kind: 'action', id: 'deny', label: 'Deny', tone: 'deny' },
      { kind: 'action', id: 'release', label: 'On laptop', tone: 'neutral' },
    ];
  }
  return [{ kind: 'action', id: 'focus', label: 'Focus', tone: 'neutral' }];
}

const App: React.FC = () => {
  const { state, toast, cmd, answer, voice, clockOffset, logInput } = useBoard();
  const [view, setView] = useState<View>({ kind: 'board' });
  const [cursor, setCursor] = useState(0);
  const [itemIdx, setItemIdx] = useState(0);
  const [qa, setQa] = useState<QaState>(QA_START);
  const [now, setNow] = useState(Date.now());
  const armedAt = useRef(0);
  const [glow, setGlow] = useState<{ color: GlowColor; id: number } | null>(null);

  const sessions = state.sessions;
  const counts = useMemo(() => {
    const c = { needs_you: 0, running: 0, idle: 0, ended: 0 };
    for (const s of sessions) c[s.status] += 1;
    return c;
  }, [sessions]);

  // Keep the same session highlighted as the list re-sorts: a new request never moves you.
  const highlightedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessions.length === 0) { setCursor(0); highlightedIdRef.current = null; return; }
    const id = highlightedIdRef.current;
    const idx = id ? sessions.findIndex((s) => s.id === id) : -1;
    if (idx >= 0) setCursor(idx);
    else {
      const c = Math.min(cursor, sessions.length - 1);
      setCursor(c);
      highlightedIdRef.current = sessions[c].id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // Edge glow when something changes (not on the first load: that's not news).
  const lastSeen = useRef<Map<string, { status: SessionStatus; since?: number }> | null>(null);
  useEffect(() => {
    if (!state.serverTime) return; // still the empty placeholder, before the first real board
    const prev = lastSeen.current;
    lastSeen.current = new Map(sessions.map((s) => [s.id, { status: s.status, since: s.pending?.since }]));
    if (!prev) return;
    const color = glowFor(prev, sessions);
    if (color) setGlow({ color, id: Date.now() });
  }, [sessions, state.serverTime]);
  useEffect(() => {
    if (!glow) return;
    const t = window.setTimeout(() => setGlow(null), GLOW_MS);
    return () => window.clearTimeout(t);
  }, [glow]);

  useEffect(() => {
    const tick = () => setNow(Date.now() + clockOffset);
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [clockOffset]);

  const cardSession = view.kind === 'card' ? sessions.find((s) => s.id === view.id) : undefined;
  const questions = heldQuestions(cardSession);
  const question = questions ? questions[Math.min(qa.qIndex, questions.length - 1)] : undefined;
  /** A dictation in progress for the open card's session. */
  const voiceHere = cardSession && voice.phase !== 'idle' && voice.sessionId === cardSession.id ? voice : undefined;
  const items = useMemo(() => (cardSession ? itemsFor(cardSession, qa, voiceHere) : []), [cardSession, qa, voiceHere]);

  // If the card's session disappears, fall back to the board.
  useEffect(() => {
    if (view.kind === 'card' && !cardSession) setView({ kind: 'board' });
  }, [view, cardSession]);

  // A different request (or none) on this card: start any question over.
  const pendingKey = cardSession ? `${cardSession.id}:${cardSession.pending?.since ?? ''}:${cardSession.pending?.heldOnDevice ?? ''}` : '';
  useEffect(() => { setQa(QA_START); }, [pendingKey]);

  // New card, request, or question: put the dial on the first choice and re-arm.
  const itemsKey = `${pendingKey}:${qa.qIndex}:${items.length}:${voiceHere?.phase ?? ''}`;
  useEffect(() => {
    setItemIdx(0);
    armedAt.current = Date.now() + ARM_DELAY_MS;
  }, [itemsKey]);

  const open = useCallback((s: SessionView) => {
    highlightedIdRef.current = s.id;
    setView({ kind: 'card', id: s.id }); // the Mac only moves when you press Focus
  }, []);

  /** Record an answer to the current question; send them all after the last one. */
  const advance = useCallback((value: string) => {
    if (!cardSession || !questions || !question) return;
    const answers = { ...qa.answers, [question.question]: value };
    if (qa.qIndex + 1 < questions.length) setQa({ qIndex: qa.qIndex + 1, answers, picked: [] });
    else {
      answer(cardSession.id, answers);
      setQa(QA_START);
    }
  }, [cardSession, questions, question, qa, answer]);

  const choose = useCallback((item: Item | undefined) => {
    if (!item || !cardSession) return;
    switch (item.kind) {
      case 'action':
        cmd(item.id, cardSession.id);
        break;
      case 'laptop':
        cmd('release', cardSession.id);
        break;
      case 'option':
        if (question?.multiSelect) {
          setQa((q) => ({
            ...q,
            picked: q.picked.includes(item.index) ? q.picked.filter((i) => i !== item.index) : [...q.picked, item.index],
          }));
        } else {
          advance(item.label);
        }
        break;
      case 'done':
        if (!item.disabled && question) {
          advance(question.options.filter((_, i) => qa.picked.includes(i)).map((o) => o.label).join(', '));
        }
        break;
    }
  }, [cardSession, cmd, question, qa, advance]);

  const back = useCallback(() => {
    if (questions && qa.qIndex > 0) setQa((q) => ({ qIndex: q.qIndex - 1, answers: q.answers, picked: [] }));
    else setView({ kind: 'board' });
  }, [questions, qa.qIndex]);

  const act = useCallback((intent: Intent) => {
    if (view.kind === 'board') {
      if (intent === 'prev' || intent === 'next') {
        if (sessions.length === 0) return;
        setCursor((c) => {
          const next = Math.min(sessions.length - 1, Math.max(0, c + (intent === 'next' ? 1 : -1)));
          highlightedIdRef.current = sessions[next].id;
          return next;
        });
      } else if (intent === 'select') {
        const s = sessions[cursor];
        if (s) open(s);
      }
      return;
    }
    // card
    if (intent === 'back') back();
    else if (intent === 'prev') setItemIdx((i) => Math.max(0, i - 1));
    else if (intent === 'next') setItemIdx((i) => Math.min(items.length - 1, i + 1));
    else if (intent === 'select' && Date.now() >= armedAt.current) choose(items[itemIdx]);
  }, [view, sessions, cursor, open, back, items, itemIdx, choose]);

  /** Start hold-to-talk on the open card, or on the highlighted row (opening its card). */
  const startVoice = useCallback(() => {
    const target = view.kind === 'card' ? cardSession : sessions[cursor];
    if (!target) return null;
    if (view.kind === 'board') open(target);
    cmd('voice-start', target.id);
    return target.id;
  }, [view.kind, cardSession, sessions, cursor, open, cmd]);

  // The dial press is handled on release: a short press selects, a long hold talks.
  const press = useRef<{ timer: number | null; voiceFor: string | null } | null>(null);

  // ---- hardware input: dial (wheel) + dial press / back (keys)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      logInput({ kind: 'key', code: e.code });
      if (e.repeat) return;
      const intent = intentForKey(e.code);
      if (!intent) return;
      e.preventDefault();
      if (intent === 'select') {
        if (voice.phase === 'listening') { cmd('voice-stop', voice.sessionId); return; } // missed release
        if (press.current) return;
        const p: { timer: number | null; voiceFor: string | null } = { timer: null, voiceFor: null };
        if (state.dictation?.enabled) {
          p.timer = window.setTimeout(() => {
            p.timer = null;
            p.voiceFor = startVoice();
          }, HOLD_TO_TALK_MS);
        } else {
          p.timer = -1; // hold-to-talk is off: any press, however long, is a press
        }
        press.current = p;
        return;
      }
      if (voice.phase === 'starting' || voice.phase === 'listening') return; // dial busy talking
      act(intent);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (intentForKey(e.code) !== 'select' || !press.current) return;
      e.preventDefault();
      const p = press.current;
      press.current = null;
      if (p.timer !== null) {
        if (p.timer !== -1) window.clearTimeout(p.timer);
        act('select');
      } else if (p.voiceFor) {
        cmd('voice-stop', p.voiceFor);
      }
    };
    let lastStep = 0;
    const onWheel = (e: WheelEvent) => {
      logInput({ kind: 'wheel', dx: e.deltaX, dy: e.deltaY });
      e.preventDefault();
      if (voice.phase === 'starting' || voice.phase === 'listening') return;
      const dir = wheelDirection(e);
      if (dir === 0) return;
      const t = Date.now();
      if (t - lastStep < WHEEL_MIN_INTERVAL_MS) return;
      lastStep = t;
      act(dir > 0 ? 'next' : 'prev');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('wheel', onWheel);
    };
  }, [act, logInput, cmd, voice, startVoice, state.dictation?.enabled]);

  // Keep the highlighted row (board) or choice (question list) scrolled into view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const idx = view.kind === 'board' ? cursor : itemIdx;
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [cursor, itemIdx, view.kind, qa.qIndex]);

  const othersWaiting = cardSession ? counts.needs_you - (cardSession.status === 'needs_you' ? 1 : 0) : 0;

  return (
    <>
    <div className="app">
      {view.kind === 'board' || !cardSession ? (
        <Board
          sessions={sessions}
          counts={counts}
          cursor={cursor}
          now={now}
          listRef={listRef}
          onPick={open}
          listening={state.hookServer.listening}
          port={state.hookServer.port}
        />
      ) : (
        <div className={`card status-${cardSession.status}`}>
          <CardHead s={cardSession} now={now} onBack={back} />
          {voiceHere ? (
            <VoiceBody
              v={voiceHere}
              app={state.dictation?.app || 'Dictation'}
              target={AGENT_APP[cardSession.agent]}
              items={items}
              selected={itemIdx}
              onPick={(i) => { setItemIdx(i); choose(items[i]); }}
            />
          ) : questions && question ? (
            <QuestionBody
              q={question}
              index={qa.qIndex}
              total={questions.length}
              items={items}
              selected={itemIdx}
              listRef={listRef}
              onPick={(i) => { setItemIdx(i); choose(items[i]); }}
            />
          ) : (
            <ActionBody
              s={cardSession}
              dictation={state.dictation}
              items={items}
              selected={itemIdx}
              othersWaiting={othersWaiting}
              onPick={(i) => { setItemIdx(i); choose(items[i]); }}
            />
          )}
        </div>
      )}

      {toast && <div key={toast.id} className={`toast toast-${toast.kind}`}><i />{toast.text}</div>}
    </div>
    {glow && <EdgeGlow key={glow.id} color={glow.color} />}
    </>
  );
};

export default App;

// ------------------------------------------------------------------ pieces

/** A soft light around the screen edges (full screen, including under the dial). */
const EdgeGlow: React.FC<{ color: GlowColor }> = ({ color }) => (
  <div className={`edge-glow edge-${color}`}>
    <div className="glow glow-a" />
    <div className="glow glow-b" />
  </div>
);

/** macOS-style rounded-square icon for a session's state. */
const StatusIcon: React.FC<{ s: SessionView; small?: boolean }> = ({ s, small }) => {
  let glyph: React.ReactNode;
  if (s.status === 'needs_you') {
    glyph = s.pending?.kind === 'question' ? (
      <path d="M9.2 9.3a2.9 2.9 0 1 1 4.2 2.6c-.9.5-1.4 1.1-1.4 2v.6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    ) : (
      <path d="M12 6.5v7.2" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    );
    glyph = <>{glyph}<circle cx="12" cy="18" r="1.55" fill="#fff" /></>;
  } else if (s.status === 'running') {
    glyph = <circle className="spin" cx="12" cy="12" r="6.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="28 14" />;
  } else if (s.status === 'idle') {
    glyph = <path d="M7 12.4l3.4 3.4L17.2 8.6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />;
  } else {
    glyph = <path d="M8 12h8" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />;
  }
  return (
    <span className={`sicon sicon-${s.status}${small ? ' sicon-sm' : ''}`}>
      <svg viewBox="0 0 24 24" width="100%" height="100%">{glyph}</svg>
    </span>
  );
};

const StatusText: React.FC<{ status: SessionStatus; since: number; now: number }> = ({ status, since, now }) => (
  <span className={`stext stext-${status}`}>
    {STATUS_LABEL[status]}
    <span className="stext-time"> · {elapsed(since, now)}</span>
  </span>
);

const Board: React.FC<{
  sessions: SessionView[];
  counts: Record<SessionStatus, number>;
  cursor: number;
  now: number;
  listRef: React.RefObject<HTMLDivElement>;
  onPick: (s: SessionView) => void;
  listening: boolean;
  port: number;
}> = ({ sessions, counts, cursor, now, listRef, onPick, listening, port }) => {
  if (sessions.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">No sessions yet</div>
        <div className="empty-sub">
          {listening
            ? `Listening on :${port}. In DeskThing, turn on “Install Claude Code hooks” in AgentThing’s settings, then start a Claude Code session.`
            : 'The hook server isn’t listening. Check AgentThing’s settings in DeskThing.'}
        </div>
      </div>
    );
  }
  // Only label rows by app when there's more than one kind on the board.
  const mixed = new Set(sessions.map((s) => s.agent)).size > 1;
  return (
    <>
      <div className="board-head">
        <span className="board-title">Sessions</span>
        {counts.needs_you > 0 && <span className="count count-needs_you"><i />{counts.needs_you} need you</span>}
        {counts.running > 0 && <span className="count count-running"><i />{counts.running} running</span>}
        {counts.idle > 0 && <span className="count count-idle"><i />{counts.idle} done</span>}
      </div>
      <div className="list">
        <div className="group" ref={listRef}>
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={`row status-${s.status}${i === cursor ? ' row-hl' : ''}`}
              onClick={() => onPick(s)}
            >
              <StatusIcon s={s} />
              <div className="row-main">
                <div className="row-top">
                  <span className="row-title">{s.title}</span>
                  {s.focused && <span className="row-focused" />}
                  <span className="row-right">
                    {mixed && <span className={`agent agent-${s.agent}`}>{AGENT_LABEL[s.agent]}</span>}
                    {s.model && <span className="row-model">{s.model}</span>}
                  </span>
                </div>
                <div className="row-meta">
                  <StatusText status={s.status} since={s.statusSince} now={now} />
                  <span className="row-sub">{rowSubtitle(s)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

function firstLine(t?: string): string | undefined {
  return t ? t.split('\n')[0] : undefined;
}

function rowSubtitle(s: SessionView): string {
  if (s.status === 'needs_you' && s.pending) return s.pending.summary;
  if (s.status === 'running') return s.lastTool || firstLine(s.lastPrompt) || s.folder;
  if (s.status === 'idle') return firstLine(s.lastMessage) || s.folder;
  return s.folder;
}

const CardHead: React.FC<{ s: SessionView; now: number; onBack: () => void }> = ({ s, now, onBack }) => (
  <div className="card-head">
    <button className="card-back" onClick={onBack} aria-label="Back">
      <span className="chev" />
    </button>
    <StatusIcon s={s} small />
    <div className="card-titles">
      <div className="card-title">{s.title}</div>
      <div className="card-meta">
        <StatusText status={s.status} since={s.statusSince} now={now} />
        <span className="card-sub">{s.folder} · {AGENT_LABEL[s.agent]}{s.model ? ` · ${s.model}` : ''}</span>
      </div>
    </div>
  </div>
);

const QuestionBody: React.FC<{
  q: Question;
  index: number;
  total: number;
  items: Item[];
  selected: number;
  listRef: React.RefObject<HTMLDivElement>;
  onPick: (i: number) => void;
}> = ({ q, index, total, items, selected, listRef, onPick }) => {
  const label = [
    total > 1 ? `Question ${index + 1} of ${total}` : 'Question',
    q.header,
    q.multiSelect ? 'Pick any' : undefined,
  ].filter(Boolean).join(' · ');
  return (
    <div className="q-body">
      <div className="card-label">{label}</div>
      <div className="q-text">{q.question}</div>
      <div className="q-list">
        <div className="group" ref={listRef}>
        {items.map((it, i) => {
          const sel = i === selected ? ' opt-sel' : '';
          const firstAction = it.kind !== 'option' && items[i - 1]?.kind === 'option' ? ' opt-first-action' : '';
          if (it.kind === 'option') {
            return (
              <div key={`o${it.index}`} className={`opt${sel}${it.checked ? ' opt-checked' : ''}`} onClick={() => onPick(i)}>
                <span className={it.checked !== undefined ? 'opt-check' : 'opt-radio'} />
                <div className="opt-text">
                  <div className="opt-label">{it.label}</div>
                  {it.description && <div className="opt-desc">{it.description}</div>}
                </div>
              </div>
            );
          }
          if (it.kind === 'done') {
            return (
              <div key="done" className={`opt opt-done${sel}${firstAction}${it.disabled ? ' opt-disabled' : ''}`} onClick={() => onPick(i)}>
                <div className="opt-label">{it.label}</div>
              </div>
            );
          }
          return (
            <div key="laptop" className={`opt opt-laptop${sel}${firstAction}`} onClick={() => onPick(i)}>
              <div className="opt-label">{it.label}</div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
};

/** Hold-to-talk on a card: listening, then what Rhino typed, then Send. */
const VoiceBody: React.FC<{
  v: VoiceState;
  app: string;
  /** The app the words are typed into: Claude or ChatGPT. */
  target: string;
  items: Item[];
  selected: number;
  onPick: (i: number) => void;
}> = ({ v, app, target, items, selected, onPick }) => {
  const live = v.phase === 'starting' || v.phase === 'listening';
  const title =
    v.phase === 'starting' ? 'Opening it on the laptop…'
    : v.phase === 'listening' ? 'Listening'
    : v.phase === 'typing' ? `${app} is typing…`
    : `Typed into ${target}`;
  const sub =
    v.phase === 'starting' ? 'Keep holding the dial'
    : v.phase === 'listening' ? 'Let go of the dial when you’re done'
    : v.phase === 'typing' ? ''
    : v.text ? '' : 'Check the prompt box on the laptop';
  return (
    <>
      <div className="voice-body">
        {v.phase === 'ready' ? (
          <>
            <div className="card-label">{title}</div>
            {v.text ? <div className="card-main voice-text">“{v.text}”</div> : <div className="card-main voice-none">{sub}</div>}
          </>
        ) : (
          <div className="voice-live">
            <div className={`mic${live ? ' mic-live' : ''}${v.phase === 'listening' ? ' mic-on' : ''}`}>
              <svg viewBox="0 0 24 24" width="44" height="44">
                <rect x="8.5" y="3" width="7" height="12" rx="3.5" fill="#fff" />
                <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="voice-title">{title}</div>
            {sub && <div className="voice-sub">{sub}</div>}
          </div>
        )}
      </div>
      {items.length > 0 && (
        <div className="card-foot">
          <div className="card-actions">
            {items.map((it, i) => it.kind === 'action' && (
              <button key={it.id} className={`btn btn-${it.tone}${i === selected ? ' btn-sel' : ''}`} onClick={() => onPick(i)}>
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
};

const ActionBody: React.FC<{
  s: SessionView;
  dictation?: { enabled: boolean; app: string; key: string };
  items: Item[];
  selected: number;
  othersWaiting: number;
  onPick: (i: number) => void;
}> = ({ s, dictation, items, selected, othersWaiting, onPick }) => {
  const p = s.pending;
  const held = !!p?.heldOnDevice;
  let label: string;
  let main: string;
  let detail: string | undefined;
  let mono = false;
  if (s.status === 'needs_you' && p) {
    if (!held) label = p.kind === 'question' ? 'Question waiting on the laptop' : 'Waiting on the laptop';
    else label = p.kind === 'plan' ? 'Plan ready' : 'Wants permission';
    main = p.summary;
    detail = p.detail && p.detail !== p.summary ? p.detail : undefined;
    mono = p.kind === 'tool';
  } else if (s.status === 'running') {
    label = 'Working on';
    main = s.lastPrompt || '…';
    detail = s.lastTool;
  } else {
    label = 'Last said';
    main = s.lastMessage || 'Nothing yet';
    detail = s.lastPrompt ? `You: ${firstLine(s.lastPrompt)}` : undefined;
  }

  return (
    <>
      <div className="card-body">
        <div className="card-label">{label}</div>
        <div className={`card-main${mono ? ' card-main-cmd' : ''}`}>{main}</div>
        {detail && (mono ? (
          <div className="detail-box"><div className="card-detail mono">{detail}</div></div>
        ) : (
          <div className="card-detail">{detail}</div>
        ))}
      </div>

      <div className="card-foot">
        {!s.pending && othersWaiting === 0 && dictation?.enabled && (
          <div className="hint">Hold the dial to talk to this session · {dictation.app}</div>
        )}
        {othersWaiting > 0 && (
          <div className="others"><i />{othersWaiting} other{othersWaiting > 1 ? 's' : ''} waiting · Back to see</div>
        )}
        <div className="card-actions">
          {items.map((it, i) => it.kind === 'action' && (
            <button
              key={it.id}
              className={`btn btn-${it.tone}${i === selected ? ' btn-sel' : ''}`}
              onClick={() => onPick(i)}
            >
              {it.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
};
