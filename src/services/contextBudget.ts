// Token-budget planning for long roleplay chats.
//
// The chat history is split into three zones:
//   1. summarized  - older messages already covered by the rolling summary
//   2. gap         - messages that are neither summarized nor fit the verbatim window yet
//   3. verbatim    - the newest messages, sent word for word within the token budget
// Nothing falls between zones, so no part of the story is silently lost.

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

export interface WindowPlan {
  /** First index of the verbatim zone. */
  verbatimFrom: number;
  /** Messages in [gapFrom, verbatimFrom) have no coverage and need a short synopsis. */
  gapFrom: number;
}

/**
 * @param tokens         token cost of every message in chronological order
 * @param summarizedCount number of leading messages already covered by the summary, or -1 when unknown
 * @param budget         tokens available for verbatim dialogue
 * @param maxVerbatim    hard cap on the number of verbatim messages
 */
export function planDialogueWindow(
  tokens: number[],
  summarizedCount: number,
  budget: number,
  maxVerbatim: number
): WindowPlan {
  const n = tokens.length;
  if (n === 0) return { verbatimFrom: 0, gapFrom: 0 };

  const floor = summarizedCount > 0 ? Math.min(summarizedCount, n - 1) : 0;
  let from = n - 1;
  let used = tokens[n - 1];
  while (from - 1 >= floor && n - from < maxVerbatim && used + tokens[from - 1] <= budget) {
    from--;
    used += tokens[from];
  }

  const gapFrom = summarizedCount < 0 ? from : Math.min(Math.max(summarizedCount, 0), from);
  return { verbatimFrom: from, gapFrom };
}

/**
 * Decide whether the rolling summary should absorb older messages after a reply.
 * Compression runs in batches: it triggers when the unsummarized dialogue approaches the
 * budget, then folds everything except roughly half the budget into the summary.
 * Returns the exclusive end index of the range to summarize, or null when nothing is needed.
 */
export function planCompression(
  tokens: number[],
  summarizedCount: number,
  budget: number,
  maxVerbatim: number
): number | null {
  const n = tokens.length;
  const start = Math.max(summarizedCount, 0);
  const pending = n - start;
  if (pending <= 2) return null;

  let pendingTokens = 0;
  for (let i = start; i < n; i++) pendingTokens += tokens[i];
  const overBudget = pendingTokens > budget * 0.85;
  const overCount = pending > maxVerbatim;
  if (!overBudget && !overCount) return null;

  const keepTokens = budget * 0.5;
  const keepMax = Math.max(2, Math.floor(maxVerbatim / 2));
  let keep = 0;
  let kept = 0;
  for (let i = n - 1; i >= start && keep < keepMax; i--) {
    if (keep >= 2 && kept + tokens[i] > keepTokens) break;
    kept += tokens[i];
    keep++;
  }

  const end = n - keep;
  return end > start ? end : null;
}

/** Summary length that suits the available prompt budget. */
export function summaryLimits(promptTarget: number): { maxChars: number; maxTokens: number } {
  const maxChars = Math.max(1200, Math.min(3200, Math.round(promptTarget * 0.18 * 2.6)));
  return { maxChars, maxTokens: Math.min(900, Math.round(maxChars / 2.2)) };
}
