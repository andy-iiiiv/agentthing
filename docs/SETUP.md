# Setting up AgentThing

About five minutes. You'll need:

- a Spotify Car Thing with DeskThing on it, plugged into your Mac, with the DeskThing app running on the Mac;
- Claude Code, in the Claude Desktop app or the CLI, and/or Codex in the ChatGPT Mac app or the Codex CLI;
- optional, for hold to talk: a dictation app with a push-to-talk key, such as Rhino, Wispr Flow or Superwhisper.

AgentThing is Mac only.

---

## 1. Install AgentThing in DeskThing

**From GitHub (gets updates):** in the DeskThing app, go to the app downloads and add this repository:

```
https://github.com/andy-iiiiv/agentthing
```

AgentThing appears in the list; install it.

**Or from a zip:** download `agentthing-v….zip` from the [latest release](https://github.com/andy-iiiiv/agentthing/releases/latest), then in the DeskThing app go to **Apps → Add from zip** (or drag the zip in).

Enable the app, then open **AgentThing** on the Car Thing. You'll see "No sessions yet" until the next step is done.

## 2. Connect Claude Code

Claude Code tells AgentThing what your sessions are doing through *hooks*: small commands it runs at each step (a prompt, a tool, a permission request, the end of a turn). AgentThing can add them for you.

**The easy way:** in the DeskThing app, open AgentThing's settings and turn on **Install Claude Code hooks**.

That adds AgentThing's hooks to `~/.claude/settings.json`, next to any hooks you already have, and saves a backup beside it first (`settings.json.agentthing-<date>.bak`). AgentThing's hooks are the ones ending in `# agentthing`. Turning the setting off removes them again, and only them.

**Then start a new Claude Code session.** Sessions that were already open keep the hooks they started with, so restart those (or just start new ones). The Claude Desktop app and the CLI both read `~/.claude/settings.json`.

**By hand, if you'd rather:** merge [`claude-settings/hooks.json`](../claude-settings/hooks.json) into `~/.claude/settings.json` yourself. Keep them as `command` hooks: Claude Desktop doesn't run `http`-type hooks. The `PermissionRequest` hook has a 150 s timeout so requests can wait on the Car Thing; `|| true` keeps the hooks quiet when DeskThing isn't running, so nothing breaks when the Car Thing is unplugged.

**Check it:** send a prompt in a new session. A row should appear on the Car Thing within a second or two. If not, see [Troubleshooting](#troubleshooting).

### Codex threads (ChatGPT app)

In AgentThing's settings, turn on **Install Codex hooks (ChatGPT app)**. That adds AgentThing's hooks to `~/.codex/hooks.json` (backed up first; turning the setting off removes them again).

(By hand instead: merge [`claude-settings/codex-hooks.json`](../claude-settings/codex-hooks.json) into `~/.codex/hooks.json`.)

Codex only runs hooks you've trusted: open the ChatGPT app, go to **Settings → Hooks** (or **Review hooks** in the composer) and trust AgentThing's. You'll need to trust them again if they change, for example after changing AgentThing's port. Then start a new Codex thread.

What works for Codex threads: the board, approve/deny from the dial, Focus (opens the thread in ChatGPT), hold to talk, and Codex's questions: when Codex asks you something with options, the row turns *Needs you*, and picking an option sends it to the thread as your reply (ChatGPT sends it in the background). To type your own answer instead, choose *Answer on laptop*. Plain ChatGPT chats don't appear.

## 3. Try it

- **Turn the dial** to move between sessions, **press** to open one.
- When Claude asks for permission or asks a question, the screen edges glow amber and the session moves to the top. Open it, turn to **Approve**, **Deny** or an answer, and press. **On laptop** sends it to Claude on your Mac instead.
- **Focus** brings that session up in Claude Desktop.
- **Back** returns to the board.

Requests wait on the Car Thing for 2 minutes (setting: *Wait on the Car Thing*), then go to the laptop. If the Car Thing is unplugged or AgentThing isn't open on it, they go straight to the laptop.

## 4. Hold to talk (optional)

Hold the dial on a session (on the board or opened), speak, and let go. AgentThing brings the session up in Claude on your Mac and holds your dictation app's push-to-talk key while you hold the dial, so the app types your words into Claude's prompt box. The Car Thing then shows what was typed: press to **Send**, or choose **Edit on computer** to fix it in Claude and send it yourself.

### a. Pick your app and key

In AgentThing's settings:

- **Dictation app:** Rhino, Wispr Flow, Superwhisper, another app, or Off. Picking an app fills in its usual key.
- **Dictation key:** the key your app records on *while held*. You can type any combo:

  | Type | Means |
  | --- | --- |
  | `right cmd` (or `rcmd`) | hold right ⌘ |
  | `fn` | hold Fn / 🌐 |
  | `right option` | hold right ⌥ |
  | `option+space` | hold ⌥ Space |
  | `ctrl+shift+d`, `cmd+f19` | any modifiers plus one key |

  If AgentThing doesn't understand what you typed, the Car Thing tells you.

### b. Set your dictation app to the same key, as push-to-talk

It has to be a *hold-to-record* (push-to-talk) shortcut, not a toggle.

- **Rhino:** in Rhino's settings, set the dictation key to hold **right ⌘** (or **Fn**, and type `fn` in AgentThing).
- **Wispr Flow:** its push-to-talk is **Fn** by default. If you changed it in Wispr Flow's settings, type the same key in AgentThing.
- **Superwhisper:** in Superwhisper's Settings → Configuration, set a **Push to Talk** shortcut (press-and-hold to record). Superwhisper's *Toggle Recording* shortcut defaults to ⌥ Space, so either give Push to Talk ⌥ Space and move Toggle to something else, or give Push to Talk another key and type that key in AgentThing.
- **Another app:** find its push-to-talk / hold-to-record shortcut, set AgentThing's Dictation app to *Another app*, and type the shortcut.

Tested so far: Rhino with right ⌘. Other apps and keys should work the same way as long as the app accepts key presses sent by another app; if one doesn't react, try a different key.

### c. Allow DeskThing to press the key

The first time you hold the dial, macOS asks whether DeskThing may control your computer. Allow it, then hold the dial again. To check or change it later: **System Settings → Privacy & Security → Accessibility → DeskThing**.

### d. Try it

On the laptop, open some other session. On the Car Thing, hold the dial on a session until you see **Listening**. The laptop switches to that session. Say something, let go, and watch the Car Thing show what was typed. Press to **Send**.

The key is always let go when you let go of the dial, if the Car Thing disconnects, or after 2 minutes.

---

## Troubleshooting

**No sessions show up.**
- Is **Install Claude Code hooks** on in AgentThing's settings? Then start a *new* session; running ones don't pick up new hooks.
- Is AgentThing running in DeskThing? `http://127.0.0.1:8765/health` in a browser on the Mac should say `{"ok":true}`, and `http://127.0.0.1:8765/state` shows the board as JSON.
- Changed the port? With the hooks setting on, the hooks follow it; if you added them by hand, update the port in `~/.claude/settings.json` too.

**The Car Thing still shows an older version after an update.** It reloads itself once it sees the new version. If it doesn't, switch to another app on the Car Thing and back, or restart the DeskThing client.

**Requests always go to the laptop.** AgentThing only holds them while the Car Thing is connected and AgentThing is open on it. Also check *Send to the laptop when you're looking at that session there* is off.

**Focus only brings Claude forward, without opening the session.** Focus opens sessions started in Claude Desktop. Sessions run in a terminal (the CLI) can't be opened from outside.

**Hold to talk does nothing, or the wrong thing.**
- The Car Thing says the key isn't valid → fix *Dictation key*.
- "Allow DeskThing in Settings → Privacy → Accessibility" → turn DeskThing on there.
- The app doesn't start recording → its push-to-talk key isn't the one AgentThing holds, or it's a toggle shortcut rather than hold-to-record.
- The words don't land in Claude → the cursor wasn't in the prompt box. Click into Claude's prompt box once, then try again.
- The Car Thing says "Check the prompt box on the laptop" instead of showing the words → the app typed them without going through the clipboard. Send still works.

**Codex threads don't show up.** Is **Install Codex hooks** on, and have you trusted the hooks in ChatGPT → Settings → Hooks? Codex skips hooks until they're trusted. Then start a new thread.

**ChatGPT copied your Claude Code hooks.** The ChatGPT app can bring hooks over from Claude Code's settings. AgentThing recognises those Codex events either way; turning on **Install Codex hooks** replaces the copies with proper Codex ones.

**Where are the logs?** DeskThing's log on the Mac: `~/Library/Application Support/deskthing/logs/readable.log`. AgentThing's lines start with `[agentthing]`.

## Uninstalling

1. In AgentThing's settings, turn **Install Claude Code hooks** and **Install Codex hooks** off. That removes AgentThing's hooks from `~/.claude/settings.json` and `~/.codex/hooks.json`; the backups it made sit next to those files if you want them.
2. Remove AgentThing in the DeskThing app.
3. Optionally, turn DeskThing off under System Settings → Privacy & Security → Accessibility.
