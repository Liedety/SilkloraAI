import type { CharacterEmotion } from '../../types';
import { INFER_EMOTION_FROM_TEXT } from './config.ts';

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert Gemma 4 / Qwen 3 / DeepSeek native reasoning markers into uniform <thought> blocks. */
export function normalizeNativeThoughtTags(str: string): string {
  if (!str) return '';
  return str
    // Strip leading turn tags so <emotion> or <thought> sits cleanly at start.
    .replace(/^\s*(?:<\|\s*turn\s*>(?:model|assistant|user|system)?|<\s*start_of_turn\s*>(?:model|assistant|user|system)?|<\|\s*im_start\s*\|>(?:model|assistant|user|system)?)\s*/gi, '')
    // Complete Gemma 4 channel thought: <|channel>thought ... <channel|>
    .replace(/<\|\s*channel\s*>\s*thought\b\s*([\s\S]*?)<\s*channel\s*\|>/gi, '<thought>$1</thought>\n')
    // Unclosed Gemma 4 channel thought (streaming or truncated)
    .replace(/<\|\s*channel\s*>\s*thought\b\s*([\s\S]*)$/gi, '<thought>$1')
    // <|thought> ... <thought|> and [|thought|] ... [/|thought|]
    .replace(/<\|\s*thought\s*>\s*([\s\S]*?)<\s*thought\s*\|>/gi, '<thought>$1</thought>\n')
    .replace(/<\|\s*thought\s*>\s*([\s\S]*)$/gi, '<thought>$1')
    .replace(/\[\|\s*thought\s*\|\]\s*([\s\S]*?)\[\/\|\s*thought\s*\|\]/gi, '<thought>$1</thought>\n')
    // DeepSeek / Qwen <think> ... </think>
    .replace(/<think>([\s\S]*?)<\/think>/gi, '<thought>$1</thought>\n')
    .replace(/<think>([\s\S]*)$/gi, '<thought>$1');
}

export function cleanArtifacts(str: string, characterEmotions?: CharacterEmotion[]): string {
  if (!str) return '';
  let out = str
    // Strip tokenizer tokens like <|begin_of_sentence|>, < | begin__of__sentence | >, <|im_end|>, etc.
    .replace(/<\s*\|\s*[^>]+\s*\|\s*>/gi, '')
    // Strip Gemma 4, ChatML, Llama 3, and Mistral half-piped or named turn/control markers.
    .replace(/<\|\s*(?:turn|channel|thought|im_start|im_end|eot_id|endoftext|start_header_id|end_header_id|bos|eos)\s*>?(?:model|assistant|user|system|thought)?/gi, '')
    .replace(/<\s*(?:turn|channel|thought|im_end|eot_id|endoftext)\s*\|>/gi, '')
    .replace(/\[\|\s*thought\s*\|\]|\[\s*\/\|\s*thought\s*\|\]/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\s*(?:start_of_turn|end_of_turn)\s*>(?:user|model|system)?/gi, '')
    .replace(/<\/?s>/gi, '')
    .replace(/\uFFFD|[\u200B-\u200D\uFEFF]/g, '')
    // Strip echoed internal scene notes, prompt headers, or simulated follow-up turns
    .replace(/\n*\[\s*(?:Заметка сцены|Scene note|Контекст хода|Контекст сцены|Указание к ответу|УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ|USER TURN DIRECTIVE)[\s\S]*$/gi, '')
    .replace(/\n*---\s*\n\s*(?:Контекст сцены|Текущий контекст сцены|Scene context|Current scene context|УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ|USER TURN DIRECTIVE)[\s\S]*$/gi, '')
    .replace(/\n*###\s*(?:ТВОЯ РОЛЬ|ФУНДАМЕНТАЛЬНЫЕ|СТИЛЬ|КОНТРОЛЬ|ОБЯЗАТЕЛЬНЫЙ|CRITICAL|YOUR CURRENT ROLE|CORE PRINCIPLES)[\s\S]*$/gi, '')
    // Strip simulated turns starting with >user, >fuser, >assistant, bare user/assistant line, [Собеседник:], or dumped character sheets
    .replace(/(?:\n|(?<=\S)\s+)>+\s*(?:f?user|assistant|model|human|bot)\b[\s\S]*$/gi, '')
    .replace(/\n\s*>+\s*\*\*(?:Имя|Пол|Год рождения|Возраст|Класс|Характеристики|Умения|Способности|Аппаратура|Name|Gender|Age|Class)\s*[:*][\s\S]*$/gi, '')
    .replace(/\n\s*(?:f?user|assistant)\s*(?:\r?\n|$)[\s\S]*$/gi, '')
    .replace(/\n\s*\[\s*(?:Собеседник|Реплика\s+собеседника|Пользователь|User|Assistant)\s*[:\]][\s\S]*$/gi, '')
    .replace(/\n\s*<user>[\s\S]*$/gi, '')
    .replace(/\n\s*User:[\s\S]*$/gi, '')
    .replace(/\n\s*(?:Пользователь|Вы|Игрок):[\s\S]*$/g, '')
    .replace(/(?:\n|(?<=\S)\s+)>+\s*[\p{Lu}][\p{Ll}\p{L}-]{1,24}(?:\s*\([^)]+\))?\s*:[\s\S]*$/u, '')
    // Strip leading turn/technical bracket prefixes like >**Name:**, >user, <user>, [Ответ], []
    .replace(/^\s*(?:>+\s*)?(?:\*\*)?\[\s*(?:Собеседник|Реплика|Ответ|Сцена|Диалог|Action|Dialogue|OOC|System|Assistant|User|Bot)\s*(?::[^\]]*)?\]\s*(?:\*\*)?\s*/gi, '')
    .replace(/^\s*<user>[:\s]*/i, '')
    .replace(/^\s*<bot>[:\s]*/i, '')
    .replace(/^\s*<assistant>[:\s]*/i, '')
    .replace(/^\s*>+\s*(?:f?user|assistant|model|bot)[:\s]*/i, '')
    .replace(/^\s*User:[:\s]*/i, '')
    .replace(/^\s*Bot:[:\s]*/i, '')
    .replace(/^\s*Assistant:[:\s]*/i, '')
    .replace(/^\s*(?:>+\s*)?(?:\*\*)?(?:Пользователь|Вы|Игрок|You|Player)(?:\*\*)?\s*:\s*/i, '');

  out = stripEmotionTags(out, characterEmotions, { stripLeadingUnknownAngleTag: true });

  return out
    // Strip empty/malformed brackets, decorative markdown rules, stray invented XML tags (<joke>, </joke>), and leading '>' quotes
    .replace(/\[\s*\]/g, '')
    .replace(/<\s*\/?\s*>/g, '')
    .replace(/(?:^|\n)\s*---+\s*(?:\n|$)/g, '\n')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]{1,24})\s*>/g, (full, tag) =>
      HTML_OR_SYSTEM_TAGS.has(tag.toLowerCase()) || HTML_OR_SYSTEM_TAGS.has('/' + tag.toLowerCase()) ? full : ''
    )
    .replace(/^\s*>+\s*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    // Clean accidental bilingual translation parentheticals (e.g. "слово (word)")
    .replace(/([а-яА-ЯёЁ]{2,30})\s*\([a-zA-Z\s]{2,30}\)/g, '$1')
    .replace(/([a-zA-Z]{2,30})\s*\(([а-яА-ЯёЁ\s]{2,30})\)/g, '$2')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/\{\s*\.\.\.\s*\}/g, '')
    .replace(/\{\{\s*user\s*\}\}/gi, 'ты')
    .replace(/\{\{\s*char\s*\}\}/gi, '')
    .replace(/\{\s*user\s*\}/gi, 'ты')
    .replace(/\{\s*char\s*\}/gi, '')
    .replace(/\s*[\{\}]\s*$/g, '')
    .replace(/^\s*[\{\}]\s*/g, '')
    .trim();
}

export interface ParsedBotResponse {
  text: string;
  thought?: string;
  emotion?: string;
}

/**
 * Robustly parses and extracts character emotion, inner monologue thoughts, and clean visible text
 * from a raw LLM response. Prevents default-to-neutral traps by extracting tags from anywhere
 * (including inside thoughts) and heuristically analyzing emotional context when tags are absent.
 */
const EMOTION_SYNONYMS: Record<string, string[]> = {
  happy: ['happy', 'joy', 'smile', 'smiling', 'laugh', 'радость', 'улыбка', 'веселье', 'счастье', 'смех'],
  sad: ['sad', 'sorrow', 'cry', 'crying', 'грусть', 'печаль', 'слезы', 'тоска'],
  angry: ['angry', 'furious', 'rage', 'гнев', 'злость', 'ярость', 'раздражение'],
  blushing: ['blushing', 'shy', 'embarrassed', 'смущение', 'стыд', 'румянец'],
  smirk: ['smirk', 'tease', 'playful', 'усмешка', 'сарказм', 'ухмылка'],
  surprised: ['surprised', 'shocked', 'удивление', 'шок', 'испуг'],
  thoughtful: ['thoughtful', 'pensive', 'задумчивость', 'размышление'],
  neutral: ['neutral', 'calm', 'нейтральный', 'спокойствие'],
};

/**
 * Maps a raw tag value to one of the speaker's configured emotions.
 * Returns undefined for unknown values and for tags that belong to another character
 * (e.g. "Mira: happy" written inside a group reply by someone else).
 */
export function resolveEmotion(
  raw: string,
  emotions?: CharacterEmotion[],
  speakerName?: string
): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim().toLowerCase().replace(/^[*"'\[\/]+|[*"'\]\/]+$/g, '').trim();
  if (!value) return undefined;

  const named = value.match(/^([^:\-–—]{2,40})\s*[:–—-]\s*(.+)$/);
  if (named) {
    const who = named[1].trim();
    const speaker = (speakerName || '').trim().toLowerCase();
    if (speaker && who !== speaker && !speaker.includes(who) && !who.includes(speaker)) {
      return undefined; // tag belongs to another character
    }
    value = named[2].trim();
  }

  const list = emotions || [];
  const exact = list.find((e) => e.name.toLowerCase() === value || e.label?.toLowerCase() === value);
  if (exact) return exact.name.toLowerCase();

  const word = Object.entries(EMOTION_SYNONYMS).find(([, words]) => words.some((w) => value === w || value.includes(w)));
  if (word) {
    const target = list.find((e) => e.name.toLowerCase() === word[0] || word[1].some((w) => (e.name + ' ' + (e.label || '')).toLowerCase().includes(w)));
    if (target) return target.name.toLowerCase();
  }
  // No configured emotions at all: keep the raw value so nothing is lost
  return list.length === 0 ? value : undefined;
}

const HTML_OR_SYSTEM_TAGS = new Set([
  'thought', '/thought', 'p', '/p', 'br', 'b', '/b', 'i', '/i', 'em', '/em',
  'strong', '/strong', 'u', '/u', 's', '/s', 'a', '/a', 'div', '/div',
  'span', '/span', 'ul', '/ul', 'ol', '/ol', 'li', '/li', 'blockquote',
  '/blockquote', 'code', '/code', 'pre', '/pre', 'hr',
  'h1', '/h1', 'h2', '/h2', 'h3', '/h3', 'h4', '/h4', 'h5', '/h5', 'h6', '/h6',
  'user', 'bot', 'assistant', 'human', 'system',
]);

const KNOWN_EMOTION_WORDS = Array.from(
  new Set([
    ...Object.values(EMOTION_SYNONYMS).flat(),
    'shame', 'embarrassment', 'awkward', 'shock', 'pensive', 'tease',
    'неловкость', 'испуг', 'шок', 'стыд', 'румянец', 'сарказм', 'спокойствие',
  ])
);

function isStandardHtmlOrSystemTag(inner: string): boolean {
  const norm = inner.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return false;
  if (norm.includes('://') || /^https?:/i.test(norm)) return true;
  const tagHead = norm.split(/[\s/>]/)[0];
  return HTML_OR_SYSTEM_TAGS.has(tagHead);
}

function buildEmotionWordSet(characterEmotions?: CharacterEmotion[]): Set<string> {
  const set = new Set<string>(KNOWN_EMOTION_WORDS);
  for (const em of characterEmotions || []) {
    if (em.name?.trim()) set.add(em.name.trim().toLowerCase());
    if (em.label?.trim()) set.add(em.label.trim().toLowerCase());
  }
  return set;
}

function isKnownOrConfiguredEmotionTag(inner: string, wordSet: Set<string>): boolean {
  let val = inner.trim().toLowerCase().replace(/^[*"'\[\/]+|[*"'\]\/]+$/g, '').trim();
  if (!val) return false;
  const named = val.match(/^[^:\-–—]{2,40}\s*[:–—-]\s*(.+)$/);
  if (named) {
    val = named[1].trim();
  }
  if (wordSet.has(val)) return true;
  // Also recognize multi-word / comma-separated variants like "wry smirk" or "happy, smirk"
  return val.split(/[\s,;]+/).some((tok) => tok.length >= 3 && wordSet.has(tok));
}

/**
 * Strips all raw emotion markers (<emotion>...</emotion>, [emotion: ...], <happy>,
 * <smirk/>, <радость>, [happy], empty <>, or leaked leading <custom> tags) without touching
 * <thought> blocks or HTML markup.
 */
export function stripEmotionTags(
  text: string,
  characterEmotions?: CharacterEmotion[],
  options: { stripLeadingUnknownAngleTag?: boolean } = {}
): string {
  if (!text) return '';
  const wordSet = buildEmotionWordSet(characterEmotions);
  let out = text
    .replace(/<\s*(?:emotion|эмоция)(?:\s*[:=][^>\n]*)?>[\s\S]*?<\/\s*(?:emotion|эмоция)\s*>/gi, '')
    // Handle malformed split closing tags such as "< emotion>angry</emotio\nn>"
    .replace(/<\s*(?:emotion|эмоция)(?:\s*[:=][^>\n]*)?>[^<>\n]{1,36}<\/\s*(?:emot|эмоц)[a-zа-яё\s]*>?/gi, '')
    .replace(/<\s*\/?\s*(?:emotion|эмоция)(?:\s*[:=][^>\n]*)?\s*>/gi, '')
    .replace(/(?:\[|<|\()\s*(?:эмоция|emotion)\s*[:=]\s*[^\]>\)\n]+(?:\]|>|\))/gi, '')
    .replace(/<\s*\/?\s*>|\[\s*\]/g, '')
    .replace(/\[([^\[\]\n]{1,48})\]/g, (full, inner) => (isKnownOrConfiguredEmotionTag(inner, wordSet) ? '' : full))
    .replace(/<(\/?[^<>\n]{1,48})>/g, (full, inner) =>
      !isStandardHtmlOrSystemTag(inner) && !inner.includes('|') && isKnownOrConfiguredEmotionTag(inner, wordSet) ? '' : full
    );

  if (options.stripLeadingUnknownAngleTag !== false) {
    for (let i = 0; i < 4; i++) {
      const m = out.match(/^\s*<(\/?[^<>\n]{1,50})>\s*/);
      if (!m) break;
      const inner = m[1];
      if (isStandardHtmlOrSystemTag(inner) || inner.includes('|')) break;
      out = out.slice(m[0].length);
    }
  }

  return out;
}

function extractEmotionFromText(
  completed: string,
  characterEmotions?: CharacterEmotion[],
  speakerName?: string
): string | undefined {
  // 1. Standard or space/newline-glitched < emotion>...</emotion> or <эмоция>...</эмоция>
  const emTagMatch = completed.match(/<\s*(?:emotion|эмоция)(?:\s*=\s*([^>\n]+))?\s*>([\s\S]*?)<\/\s*(?:emot|эмоц)[a-zа-яё\s]*>/i);
  if (emTagMatch) {
    const val = (emTagMatch[2] || '').trim() || (emTagMatch[1] || '').trim();
    const resolved = resolveEmotion(val, characterEmotions, speakerName);
    if (resolved) return resolved;
  }

  // 2. [emotion: ...], <emotion: ...>, (emotion: ...), <emotion=...>
  const emBracketMatch = completed.match(/(?:<\s*(?:emotion|эмоция)\s*[:=]\s*([^>\n]+)>|(?:\[|\()(?:эмоция|emotion)\s*[:=]\s*([^\]\)\n]+)(?:\]|\)))/i);
  if (emBracketMatch) {
    const val = (emBracketMatch[1] || emBracketMatch[2] || '').trim();
    const resolved = resolveEmotion(val, characterEmotions, speakerName);
    if (resolved) return resolved;
  }

  const wordSet = buildEmotionWordSet(characterEmotions);

  // 3. Standalone square bracket emotions like [happy] or [радость]
  const bracketMatches = completed.matchAll(/\[([^\[\]\n]{1,48})\]/g);
  for (const m of bracketMatches) {
    if (isKnownOrConfiguredEmotionTag(m[1], wordSet)) {
      const resolved = resolveEmotion(m[1], characterEmotions, speakerName);
      if (resolved) return resolved;
    }
  }

  // 4. Shorthand angle-bracket emotions like <happy>, <smirk/>, <радость>, <Мира: smirk>
  const angleMatches = completed.matchAll(/<(\/?[^<>\n]{1,48})>/g);
  for (const m of angleMatches) {
    const inner = m[1];
    if (isStandardHtmlOrSystemTag(inner) || inner.includes('|')) continue;
    if (isKnownOrConfiguredEmotionTag(inner, wordSet)) {
      const resolved = resolveEmotion(inner, characterEmotions, speakerName);
      if (resolved) return resolved;
    }
  }

  return undefined;
}

export function extractEmotionAndCleanResponse(
  completed: string,
  characterEmotions?: CharacterEmotion[],
  speakerName?: string
): ParsedBotResponse {
  if (!completed || !completed.trim()) {
    return { text: '' };
  }

  const normalized = normalizeNativeThoughtTags(completed);
  let finalEmotion = extractEmotionFromText(normalized, characterEmotions, speakerName);

  // Extract thoughts: <thought>...</thought>
  let finalThought = '';
  let visibleText = stripEmotionTags(normalized, characterEmotions, { stripLeadingUnknownAngleTag: true });

  const thoughtMatch = visibleText.match(/<thought>([\s\S]*?)<\/thought>/i);
  if (thoughtMatch) {
    finalThought = thoughtMatch[1].trim();
    visibleText = visibleText.replace(/<thought>[\s\S]*?<\/thought>/i, '').trim();
  } else if (/^\s*<thought>/i.test(visibleText)) {
    // Unclosed thought block
    finalThought = visibleText.replace(/^\s*<thought>/i, '').trim();
    visibleText = '';
  }

  if (finalThought) {
    finalThought = stripEmotionTags(finalThought, characterEmotions, { stripLeadingUnknownAngleTag: false }).trim();
  }

  // 4. Keyword inference from prose is off: the avatar changes only on an explicit <emotion> tag.
  // (It used to change the avatar whenever the narration mentioned a smile, tears, etc.)
  if (INFER_EMOTION_FROM_TEXT && !finalEmotion && characterEmotions && characterEmotions.length > 0) {
    const textToAnalyze = (visibleText + ' ' + finalThought).toLowerCase();
    const emotionPatterns: Array<{ name: string; regex: RegExp }> = [
      { name: 'happy', regex: /(?:улыб|сме|радост|счаст|весел|хохот|хихик|smile|laugh|happy|grin|giggle|cheerful|joy)/i },
      { name: 'sad', regex: /(?:плач|слез|груст|печал|вздох|тоск|рыдан|всхлип|sad|cry|tear|grief|sorrow|sigh|weep)/i },
      { name: 'angry', regex: /(?:гнев|злос|ярост|хмур|рыч|раздраж|стиснул|оскал|крик|angry|rage|furious|growl|frown|irritat|scowl|snarl)/i },
      { name: 'blushing', regex: /(?:смущ|красне|покрасн|румян|стыд|неловк|shy|blush|embarrass|fluster)/i },
      { name: 'smirk', regex: /(?:ухмыл|усмеш|сарказм|ехидн|прищур|подразн|smirk|tease|mock|sneer|playful|wry)/i },
      { name: 'surprised', regex: /(?:вздраг|удивл|шок|опешил|замер|surpris|shock|startle|gasp|stun)/i },
      { name: 'thoughtful', regex: /(?:задум|размышл|нахмурил лоб|взгляд в пустоту|pensive|thought|ponder|reflect|contemplat)/i },
    ];

    for (const ep of emotionPatterns) {
      const hasConfigured = characterEmotions.some(
        (e) => e.name.toLowerCase() === ep.name || e.label?.toLowerCase() === ep.name
      );
      if (hasConfigured && ep.regex.test(textToAnalyze)) {
        finalEmotion = ep.name;
        break;
      }
    }

    // Direct emotion name match in text
    if (!finalEmotion) {
      for (const em of characterEmotions) {
        const eName = em.name.toLowerCase();
        if (eName !== 'neutral' && new RegExp(`\\b${eName}\\b`, 'i').test(textToAnalyze)) {
          finalEmotion = eName;
          break;
        }
      }
    }

    // Default to neutral if neutral is explicitly in character emotions
    if (!finalEmotion && characterEmotions.some((e) => e.name.toLowerCase() === 'neutral')) {
      finalEmotion = 'neutral';
    }
  }

  visibleText = stripEmotionTags(visibleText, characterEmotions, { stripLeadingUnknownAngleTag: true });
  if (speakerName) {
    visibleText = stripLeadingSpeakerName(visibleText, [speakerName]);
  }

  const cleaned = cleanArtifacts(visibleText, characterEmotions);

  return {
    text: cleaned || cleanArtifacts(completed, characterEmotions),
    thought: finalThought || undefined,
    emotion: finalEmotion,
  };
}

/**
 * Shared streaming parser used by ChatView while tokens arrive: extracts emotions,
 * separates <thought>...</thought>, strips <emotion>/<word>/<> tags, and suppresses
 * incomplete leading <...> buffer fragments before they close.
 */
export function parseStreamingBotResponse(
  raw: string,
  characterEmotions?: CharacterEmotion[],
  speakerName?: string,
  extraStripNames: string[] = []
): ParsedBotResponse {
  if (!raw) return { text: '' };
  const normalized = normalizeNativeThoughtTags(raw);
  const emotion = extractEmotionFromText(normalized, characterEmotions, speakerName);
  const stripNames = [speakerName || '', ...extraStripNames].filter(Boolean);

  let work = stripLeadingSpeakerName(normalized, stripNames);
  work = stripEmotionTags(work, characterEmotions, { stripLeadingUnknownAngleTag: true });

  let thought = '';
  const thoughtMatch = work.match(/<thought>([\s\S]*?)<\/thought>/i);
  if (thoughtMatch) {
    thought = stripEmotionTags(thoughtMatch[1], characterEmotions, { stripLeadingUnknownAngleTag: false }).trim();
    work = work.replace(/<thought>[\s\S]*?<\/thought>/i, '').trimStart();
  } else if (/^\s*<thought>/i.test(work)) {
    thought = stripEmotionTags(work.replace(/^\s*<thought>/i, ''), characterEmotions, { stripLeadingUnknownAngleTag: false });
    return { text: '', thought, emotion };
  }

  work = stripEmotionTags(work, characterEmotions, { stripLeadingUnknownAngleTag: true });

  // Prevent flickering partial "<emotion", "<|channel", "<|turn", "<think", "<" before complete delimiter arrives
  if (/^\s*<[^>\n]{0,55}$/.test(work) || /^\s*<\|\s*(?:channel|turn|thought)[^>]*$/i.test(work)) {
    return { text: '', thought: thought || undefined, emotion };
  }

  work = stripLeadingSpeakerName(work, stripNames);

  return {
    text: cleanArtifacts(work, characterEmotions),
    thought: thought || undefined,
    emotion,
  };
}

export function speakerStopStrings(names: string[]): string[] {
  const stops: string[] = [];
  for (const raw of names) {
    const name = (raw || '').trim();
    if (name.length < 3) continue;
    stops.push(
      `\n${name}:`,
      `\n${name} :`,
      `\n[${name}]:`,
      `\n>${name}:`,
      ` >${name}:`,
      `>${name}:`
    );
  }
  return Array.from(new Set(stops));
}

/** Removes a leading "Name:" or "[Name]:" (even wrapped in quotes/bold) that the model copied from history. */
/**
 * If a small local model literally begins its reply by parroting the previous user turn
 * (or first full line/sentence of it), strip that echoed duplicate while keeping the real reply.
 */
export function stripEchoedUserPrefix(reply: string, lastUserText?: string): string {
  const trimmedReply = (reply || '').trim();
  const trimmedUser = (lastUserText || '').trim();
  if (!trimmedReply || trimmedUser.length < 12) return trimmedReply;

  if (trimmedReply.toLowerCase().startsWith(trimmedUser.toLowerCase())) {
    const remainder = trimmedReply.slice(trimmedUser.length).replace(/^[\s\-–—:]+/, '').trim();
    if (remainder.length >= 6) return remainder;
  }

  const firstUserLine = trimmedUser.split(/\r?\n/)[0].trim();
  if (
    firstUserLine.length >= 16 &&
    trimmedReply.toLowerCase().startsWith(firstUserLine.toLowerCase())
  ) {
    const remainder = trimmedReply.slice(firstUserLine.length).replace(/^[\s\-–—:]+/, '').trim();
    if (remainder.length >= 6) return remainder;
  }

  return trimmedReply;
}

export function stripLeadingSpeakerName(text: string, names: string[]): string {
  let out = text;
  for (let pass = 0; pass < 2; pass++) {
    for (const raw of names) {
      const name = (raw || '').trim();
      if (name.length < 2) continue;
      const escaped = escapeRegex(name);
      // 1. Markdown bold/underline name header: >**Лира:** or >**Лира**:
      out = out.replace(
        new RegExp(`^\\s*(?:>+\\s*)?(?:\\*\\*|__)\\s*\\[?(?:(?:Ответ|Реплика|Собеседник)\\s+)?${escaped}(?:\\s*\\([^)]{1,24}\\))?\\]?(?:\\s*:)?\\s*(?:\\*\\*|__)(?:\\s*:)?\\s*`, 'i'),
        ''
      );
      // 2. Plain or quoted name prefix requiring a colon: >Лира: or Лира (она): or [Лира]:
      out = out.replace(
        new RegExp(`^\\s*(?:>+\\s*)?\\[?(?:(?:Ответ|Реплика|Собеседник)\\s+)?${escaped}(?:\\s*\\([^)]{1,24}\\))?\\]?\\s*:\\s*`, 'i'),
        ''
      );
    }
  }
  return out;
}

function isActionOnlyParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return /\*/.test(trimmed) && trimmed.replace(/\*[^*\n]+\*/g, '').trim() === '';
}

/**
 * Enforces an explicit user paragraph cap or compact-brevity wish without breaking sentences:
 * first merges isolated *action* paragraphs with their adjacent spoken dialogue line, and if
 * an explicit maxParagraphs limit is still exceeded, trims trailing excess paragraphs cleanly.
 */
export function enforceParagraphLimit(
  text: string,
  maxParagraphs?: number,
  compactBrevity = false
): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const targetMax = maxParagraphs && maxParagraphs > 0 ? maxParagraphs : (compactBrevity ? 2 : 0);
  if (!targetMax) return trimmed;

  let paras = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= targetMax) return paras.join('\n\n');

  // Step 1: Losslessly merge standalone *action* lines into adjacent speech paragraphs
  while (paras.length > targetMax) {
    const idx = paras.findIndex((p) => isActionOnlyParagraph(p));
    if (idx === -1) break;
    if (idx + 1 < paras.length && !isActionOnlyParagraph(paras[idx + 1])) {
      paras.splice(idx, 2, `${paras[idx]} ${paras[idx + 1]}`);
    } else if (idx > 0) {
      paras.splice(idx - 1, 2, `${paras[idx - 1]} ${paras[idx]}`);
    } else if (idx + 1 < paras.length) {
      paras.splice(idx, 2, `${paras[idx]} ${paras[idx + 1]}`);
    } else {
      break;
    }
  }

  // Step 2: Only for an explicit user cap (e.g. "не пиши больше 2 абзацев"), keep complete leading paragraphs
  if (maxParagraphs && maxParagraphs > 0 && paras.length > maxParagraphs) {
    paras = paras.slice(0, maxParagraphs);
  }

  return paras.join('\n\n');
}

// ============================================================================
