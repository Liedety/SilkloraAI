/**
 * Reply guard: pure helpers that keep a model reply inside its own turn.
 *
 * Small local models tend to (a) keep writing lines for the user and for other characters,
 * (b) repeat a paragraph they already wrote, (c) echo formatting rules from the prompt as
 * markdown headers and bullet lists, and (d) stop in the middle of a sentence when the token
 * budget runs out. Each helper below handles one of those cases and is safe on normal text.
 */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_~`>"'«»“”„()[\]\-–—…,.!?:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(s: string): Set<string> {
  return new Set(normalizeForCompare(s).split(' ').filter((w) => w.length > 2));
}

function similarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size < 5 || sb.size < 5) return 0;
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return common / (sa.size + sb.size - common);
}

const MIN_DUP_LEN = 40;
const DUP_THRESHOLD = 0.72;

interface LineSpan {
  start: number;
  text: string;
}

function splitLines(text: string): LineSpan[] {
  const out: LineSpan[] = [];
  let pos = 0;
  for (const part of text.split('\n')) {
    out.push({ start: pos, text: part });
    pos += part.length + 1;
  }
  return out;
}

/** Index where a line repeats an earlier line of the same reply, or -1. */
export function findRepetitionBoundary(text: string): number {
  if (!text) return -1;
  const lines = splitLines(text);
  const seen: string[] = [];
  for (const line of lines) {
    const t = line.text.trim();
    if (t.length < MIN_DUP_LEN) {
      continue;
    }
    for (const prev of seen) {
      if (similarity(prev, t) >= DUP_THRESHOLD) {
        return line.start;
      }
    }
    seen.push(t);
  }
  return -1;
}

/** Removes lines that repeat an earlier line of the same reply. */
export function dedupeParagraphs(text: string): string {
  if (!text) return '';
  const kept: string[] = [];
  const seen: string[] = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (t.length >= MIN_DUP_LEN && seen.some((p) => similarity(p, t) >= DUP_THRESHOLD)) {
      continue;
    }
    if (t.length >= MIN_DUP_LEN) seen.push(t);
    kept.push(raw);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function foreignPatterns(names: string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const raw of names) {
    const name = (raw || '').trim();
    if (name.length < 2) continue;
    const e = escapeRe(name);
    // "Name:" / "[Name]:" / "**Name:**" at the start of a line, or "*Name:" inside a line
    patterns.push(new RegExp(`(?:^|\\n)[ \\t]*(?:[>*_\\[]+[ \\t]*)*${e}(?![\\p{L}])(?:[ \\t]*\\([^)\\n]{1,24}\\))?[ \\t]*[\\]*_]*[ \\t]*:`, 'u'));
    patterns.push(new RegExp(`[*_]${e}(?![\\p{L}])[ \\t]*:`, 'u'));
    // A line that opens with an action of that person: "*Name smiles.*"
    patterns.push(new RegExp(`(?:^|\\n)[ \\t]*\\*+[ \\t]*${e}[ \\t]+\\p{Ll}`, 'u'));
  }
  return patterns;
}

/**
 * Index where the reply begins to speak or act for somebody else (the user or another character),
 * or -1. Matches before `minIndex` are ignored so a legitimate opening is never cut away.
 */
export function findForeignActorBoundary(text: string, foreignNames: string[], minIndex = 30): number {
  if (!text || !foreignNames || foreignNames.length === 0) return -1;
  let earliest = -1;
  for (const re of foreignPatterns(foreignNames)) {
    const m = re.exec(text);
    if (!m) continue;
    // Point at the first non-newline character of the match so the newline is dropped with it
    let idx = m.index;
    while (idx < text.length && text[idx] === '\n') idx++;
    if (idx >= minIndex && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

const META_KEYWORD = '(?:Ответ|Объем(?:\\s+по\\s+умолчанию)?|Послания?|Правила(?:\\s+ответа)?|Инструкции?|Стиль\\s+повествования|Length|Rules?|Instructions?|Style)';
const META_HEADER_LINE = new RegExp(`^[ \\t]*#{1,6}[ \\t]*\\S.*$`);
const META_KEYWORD_LINE = new RegExp(`^[ \\t]*(?:[-•*][ \\t]+)?${META_KEYWORD}[ \\t]*:.*$`, 'i');
const BULLET_LINE = /^[ \t]*(?:[-•]|\*(?=\s))[ \t]+\S.*$/;

/** Index of a leaked prompt-style header or rule list inside the reply, or -1. */
export function findMetaLeakBoundary(text: string, minIndex = 20): number {
  if (!text) return -1;
  for (const line of splitLines(text)) {
    const t = line.text;
    if (line.start < minIndex) continue;
    if (META_HEADER_LINE.test(t) || META_KEYWORD_LINE.test(t)) return line.start;
  }
  return -1;
}

/** Removes markdown headers and rule/bullet lists that the model echoed from its instructions. */
export function stripLeakedMeta(text: string): string {
  if (!text) return '';
  const out: string[] = [];
  let skippingBullets = false;
  for (const line of text.split('\n')) {
    if (META_HEADER_LINE.test(line) || META_KEYWORD_LINE.test(line)) {
      skippingBullets = true;
      continue;
    }
    if (skippingBullets && BULLET_LINE.test(line)) continue;
    if (skippingBullets && line.trim() === '') continue;
    skippingBullets = false;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cuts a reply that stopped mid-sentence back to its last complete sentence. */
export function trimIncompleteTail(text: string): string {
  const t = (text || '').trimEnd();
  if (t.length < 150) return balanceAsterisks(t);
  if (/[.!?…»"”*)~\]]$/.test(t)) return balanceAsterisks(t);
  const re = /[.!?…]+["»”*)]*(?=\s|$)/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd >= t.length * 0.5) {
    return balanceAsterisks(t.slice(0, lastEnd).trimEnd());
  }
  return balanceAsterisks(t);
}

function balanceAsterisks(t: string): string {
  const count = (t.match(/\*/g) || []).length;
  return count % 2 === 1 ? `${t}*` : t;
}

export interface FinalizeOptions {
  /** Names of the user and of the other characters: the reply must not write for them. */
  foreignNames?: string[];
}

/** Full post-processing applied once to a finished reply. Never returns an empty string for a non-empty input. */
export function finalizeReplyText(text: string, options: FinalizeOptions = {}): string {
  const original = (text || '').trim();
  if (!original) return '';
  let out = original;

  const foreign = findForeignActorBoundary(out, options.foreignNames || [], 20);
  if (foreign > 0) {
    const cut = out.slice(0, foreign).trimEnd();
    if (cut.length >= 20) out = cut;
  }

  const meta = stripLeakedMeta(out);
  if (meta.length >= 12) out = meta;

  const deduped = dedupeParagraphs(out);
  if (deduped.length >= 12) out = deduped;

  out = trimIncompleteTail(out);
  return out.trim() || original;
}
