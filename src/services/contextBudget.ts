// Token-budget planning for long roleplay chats.
//
// The prompt is built as:
//   system (static: character, persona, style, rules)
//   rolling summary of everything before the anchor (changes only when the anchor moves)
//   verbatim window: messages from the anchor onward (grows by appending, so the start stays identical)
//   scene note appended to the last user message (affinity, memories, guidance)
//
// The anchor moves in batches, not on every turn. The local model reuses its prompt cache for the
// unchanged beginning, so a reply only has to read the few new messages. Nothing falls between the
// summary and the window: when the window would overflow the budget before the next batch is
// summarized, the oldest messages are condensed into a short synopsis instead of being dropped.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyrillic = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x400 && code <= 0x4ff) cyrillic++;
  }
  return Math.ceil(cyrillic / 2.1 + (text.length - cyrillic) / 3.4) + 1;
}

export const PER_MESSAGE_TOKENS = 8;
/** Smallest number of messages folded into the summary at once. */
export const SUMMARY_BATCH = 8;

export interface WindowPlan {
  /** Index of the first verbatim message. Messages in [anchor, windowFrom) need a synopsis. */
  windowFrom: number;
}

/**
 * Decides which messages are sent verbatim.
 * The window starts at the anchor (the summary boundary). Only when the messages from the anchor
 * would overflow the budget is the start moved forward, which then needs a synopsis for the skipped part.
 */
export function planWindow(
  tokens: number[],
  anchor: number,
  budget: number,
  maxVerbatim: number
): WindowPlan {
  const n = tokens.length;
  if (n === 0) return { windowFrom: 0 };
  const start = Math.min(Math.max(anchor, 0), n - 1);

  let from = n - 1;
  let used = tokens[n - 1];
  while (from - 1 >= start && n - from < maxVerbatim && used + tokens[from - 1] <= budget) {
    from--;
    used += tokens[from];
  }
  return { windowFrom: Math.max(from, start) };
}

/**
 * Decides whether a batch of messages should be folded into the summary now.
 * Returns the exclusive end index of the batch, or null when the window is still healthy.
 */
export function planSummaryBatch(
  tokens: number[],
  anchor: number,
  budget: number,
  maxVerbatim: number
): number | null {
  const n = tokens.length;
  const start = Math.max(anchor, 0);
  const pending = n - start;
  if (pending <= 2) return null;

  let pendingTokens = 0;
  for (let i = start; i < n; i++) pendingTokens += tokens[i];
  const overBudget = pendingTokens > budget * 0.85;
  const overCount = pending > maxVerbatim;
  if (!overBudget && !overCount) return null;

  // Fold the oldest part, keeping about half of the budget and of the verbatim count as recent dialogue.
  const keepTokens = budget * 0.5;
  const keepMax = Math.max(2, Math.floor(maxVerbatim / 2));
  let keep = 0;
  let kept = 0;
  for (let i = n - 1; i >= start && keep < keepMax; i--) {
    if (keep >= 2 && kept + tokens[i] > keepTokens) break;
    kept += tokens[i];
    keep++;
  }

  let end = n - keep;
  if (end - start < SUMMARY_BATCH) return null;
  end = start + Math.floor((end - start) / SUMMARY_BATCH) * SUMMARY_BATCH;
  return end > start ? end : null;
}

/** Summary length that suits the available prompt budget. */
export function summaryLimits(promptTarget: number): { maxChars: number; maxTokens: number } {
  const maxChars = Math.max(1200, Math.min(3200, Math.round(promptTarget * 0.18 * 2.6)));
  return { maxChars, maxTokens: Math.min(900, Math.round(maxChars / 2.2)) };
}

/** Short scene note placed at the end of the last user message. Kept separate from the stable prompt. */
export function sceneNoteLines(lines: string[]): string {
  return lines.filter((line) => line && line.trim()).join('\n');
}
