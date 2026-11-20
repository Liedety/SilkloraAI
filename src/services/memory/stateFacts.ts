import { normalizeLabel } from './scoring.ts';

export interface StateFact {
  label: string;
  detail: string;
  kind: 'clothing' | 'item' | 'pose';
}

const CLOTHING_RE = /(?:над[еи]л[аио]?|надева\p{L}*|оде[лв]\p{L}*|одева\p{L}*|накину\p{L}*|накидыва\p{L}*|натян\p{L}*|обул\p{L}*|переоде\p{L}*|сн[яи]л\p{L}*|снима\p{L}*|завяза\p{L}*|застегну\p{L}*|повяза\p{L}*|укутал\p{L}*|put(?:s|ting)? on|wears?|wore|changed into|takes? off|took off|slipped into|wrapped)/iu;
const ITEM_RE = /(?:протяну\p{L}*|вручи\p{L}*|подари\p{L}*|отда[лё]\p{L}*|передал\p{L}*|взял\p{L}*|бер[её]т|достал\p{L}*|получил\p{L}*|принес\p{L}*|принёс\p{L}*|handed|hands|gives?|gave|takes?|took|picked up|received|brought)/iu;
const POSE_RE = /(?:сел[аи]?|садится|встал[аи]?|встаёт|встает|лег[лаи]?|ложится|вошл[аи]?|входит|вышл[аи]?|выходит|подош[её]л\p{L}*|sits? down|sat down|stands? up|stood up|enters?|entered|leaves?|left the)/iu;

function plainSentence(s: string): string {
  return s.replace(/[*_`>#]+/g, '').replace(/<[^>]{1,40}>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic scene-state extraction (clothing, items that changed hands, entering/leaving, posture).
 * Small local models do not extract these facts reliably, so they are captured with plain rules
 * and later shown in the scene note.
 */
export function extractStateFacts(texts: string[], maxFacts = 3): StateFact[] {
  const facts: StateFact[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    const sentences = plainSentence(raw.replace(/\n+/g, '. ')).split(/(?<=[.!?…])\s+/);
    for (const sentence of sentences) {
      const clause = sentence.trim();
      if (clause.length < 12 || clause.length > 220) continue;
      if (/^[—-]/.test(clause) && /\?$/.test(clause)) continue;
      const kind = CLOTHING_RE.test(clause) ? 'clothing' : ITEM_RE.test(clause) ? 'item' : POSE_RE.test(clause) ? 'pose' : null;
      if (!kind) continue;
      const words = clause.replace(/[—–-]\s*/g, '').split(' ').filter(Boolean);
      const label = words.slice(0, 6).join(' ').replace(/[.,!?…:;]+$/, '');
      const norm = normalizeLabel(label);
      if (!norm || seen.has(norm)) continue;
      if (kind === 'pose' && facts.length >= 1) continue;
      seen.add(norm);
      facts.push({ label, kind, detail: clause.length > 160 ? clause.slice(0, 157).trimEnd() + '...' : clause });
      if (facts.length >= maxFacts) return facts;
    }
  }
  return facts;
}

/** Evaluates whether a dialogue exchange contains significant plot or emotional developments worth memorizing. */
export function isSignificantTurn(userText: string, botText: string, affinityDelta: number = 0): boolean {
  const trimmedUser = userText.trim();
  if (!trimmedUser) return false;

  const isTrivial =
    /^(?:привет|здравствуй(?:те)?|добрый (?:день|вечер|утро)|хай|ку|салют|hello|hi|hey|howdy|sup|good (?:morning|evening|day))[\s.!?,]*$/i.test(trimmedUser) ||
    /^(?:да|нет|ок|окей|хорошо|ладно|понял|понятно|ясно|ага|угу|спасибо|yes|no|ok|okay|sure|fine|yep|nope|thanks|thank you)[\s.!?,]*$/i.test(trimmedUser) ||
    /^(?:как дела|как твои дела|как поживаешь|что делаешь|что новенького|how are you|how is it going|how are things|what are you doing|what's up)[\s.!?]*$/i.test(trimmedUser) ||
    /^(?:привет|здравствуй|хай|hello|hi)[\s\S]{0,25}(?:как (?:дела|ты|поживаешь)|how are you|how'?s it going)[\s.!?]*$/i.test(trimmedUser);

  if (isTrivial && Math.abs(affinityDelta) < 3) {
    return false;
  }

  if (Math.abs(affinityDelta) >= 3) {
    return true;
  }

  const combined = (userText + ' ' + botText).toLowerCase();
  const significantKeywords = [
    'секрет', 'тайна', 'клятв', 'обеща', 'люблю', 'ненавиж', 'убью', 'удар', 'выстрел',
    'погиб', 'смерт', 'опасн', 'предател', 'союз', 'брак', 'артефакт', 'кровь', 'враг',
    'правд', 'ложь', 'заговор', 'secret', 'promise', 'swear', 'confess', 'danger', 'betray',
    'kill', 'death', 'love', 'hate', 'weapon', 'alliance', 'blood', 'enemy', 'artifact',
    'truth', 'mystery', 'reveal',
  ];

  if (significantKeywords.some((w) => combined.includes(w)) && trimmedUser.length >= 20) {
    return true;
  }

  return trimmedUser.length >= 75 && Math.abs(affinityDelta) >= 1;
}
