/**
 * Turn what Claude Code sends us into short plain text for a 4" screen.
 *
 * Prompts from the Desktop app can carry wrapper blocks (<system-reminder>,
 * pasted-content tags, @"/long/path" mentions). Claude's replies are markdown.
 * Neither reads well on the device, so both go through here.
 */

const MAX_CHARS = 600;

/** Plain text of a user prompt, or undefined if nothing readable is left. */
export function cleanPrompt(raw?: string): string | undefined {
  if (!raw) return undefined;
  let t = raw;
  // Context blocks Claude Code / Desktop inject: drop them with their contents.
  t = t.replace(
    /<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|user-prompt-submit-hook|ide_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  // Any other lone tags (e.g. <pasted_content id="…">): keep their text, lose the tag.
  t = t.replace(/<\/?[a-z][a-z0-9_-]*(\s[^>]*)?>/gi, ' ');
  // @"/Users/me/Documents/notes.md" → @notes.md
  t = t.replace(/@"([^"]+)"/g, (_m, p: string) => '@' + baseName(p));
  t = t.replace(/@(\/\S+)/g, (_m, p: string) => '@' + baseName(p));
  return tidy(stripMarkdown(t));
}

/** Plain text of Claude's reply (markdown stripped), lines kept. Headings are dropped if there's other text. */
export function cleanReply(raw?: string): string | undefined {
  if (!raw) return undefined;
  return tidy(stripMarkdown(raw, { dropHeadings: true })) ?? tidy(stripMarkdown(raw));
}

export function firstLineOf(text?: string): string | undefined {
  if (!text) return undefined;
  return text.split('\n').find((l) => l.trim().length > 0);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function stripMarkdown(md: string, opts: { dropHeadings?: boolean } = {}): string {
  let t = md.replace(/\r\n?/g, '\n');
  t = t.replace(/```[\s\S]*?(```|$)/g, '\n'); // fenced code: not useful on a glance screen
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links → their text

  const lines = t.split('\n').map((line) => {
    let l = line.trim();
    if (/^[\s|:-]+$/.test(l) && l.includes('-')) return ''; // table separator / hr
    if (/^(\*{3,}|_{3,})$/.test(l)) return ''; // hr
    if (/^#{1,6}\s+/.test(l)) {
      if (opts.dropHeadings) return '';
      l = l.replace(/^#{1,6}\s+/, ''); // headings
    }
    l = l.replace(/^>\s?/, ''); // quotes
    l = l.replace(/^[-*+•]\s+(\[[ xX]\]\s+)?/, ''); // bullets / task boxes
    l = l.replace(/^\d+[.)]\s+/, ''); // numbered lists
    if (l.startsWith('|')) {
      l = l
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(' · ');
    }
    return l;
  });
  t = lines.join('\n');

  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2'); // bold
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/gm, '$1$2'); // italics
  t = t.replace(/`([^`\n]+)`/g, '$1'); // inline code
  t = t.replace(/~~(.+?)~~/g, '$1');
  return t;
}

/** Collapse whitespace, drop blank lines, cap the length. */
function tidy(t: string): string | undefined {
  const lines = t
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  return truncate(lines.join('\n'), MAX_CHARS);
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}
