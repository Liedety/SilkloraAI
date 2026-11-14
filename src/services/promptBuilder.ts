import type { Character, Group, TextStylePreset, MemoryNode } from '../types';

export function isRawDialogueMemoryDetail(detail?: string): boolean {
  if (!detail) return false;
  return (
    detail.startsWith('User said:') ||
    detail.startsWith('Пользователь:') ||
    detail.includes(' | Персонаж: ') ||
    detail.includes(' | Character responded: ')
  );
}

export function substitutePromptMacros(text: string, charName: string, userName: string): string {
  if (!text) return '';
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName);
}

/**
 * Infers grammatical gender from a character/persona description when unambiguous,
 * so small local models anchor first- and second-person verb/pronoun inflections accurately.
 */
export function inferGrammaticalGender(description?: string): 'female' | 'male' | null {
  const s = (description || '').trim();
  if (!s) return null;

  const femaleCues = s.match(
    /(?:^|[^\p{L}])(?:она|её|ей|женский\s+пол|она\/её|she\/her|she|her|hers|female|woman|girl|lady|девушка|женщина|героиня|леди|королева|принцесса|ведьма|волшебница|наемница|воительница|фехтовальщица|брюнетка|блондинка|рыжеволосая|рыжая|мать|сестра|дочь|подруга|жена|студентка|невеста|пилотесса)(?=$|[^\p{L}])/giu
  )?.length || 0;

  const maleCues = s.match(
    /(?:^|[^\p{L}])(?:он|его|ему|мужской\s+пол|он\/его|he\/him|he|him|his|male|man|boy|gentleman|мужчина|парень|юноша|герой|король|принц|воин|наемник|рыцарь|отец|брат|сын|друг|муж|студент|брюнет|блондин|пилот|жених)(?=$|[^\p{L}])/giu
  )?.length || 0;

  if (femaleCues > 0 && femaleCues > maleCues) return 'female';
  if (maleCues > 0 && maleCues > femaleCues) return 'male';
  return null;
}

export interface PromptBuildParams {
  character?: Character;
  group?: Group;
  groupCharacters?: Character[];
  userPersona?: Character | null;
  /** Fallback name when the chat has no persona selected. */
  userName?: string;
  textStyle?: TextStylePreset;
  chatDirectives?: string;
  /** Optional per-turn user instruction (checked for length overrides so system & tail align). */
  turnGuidance?: string;
  thoughtsEnabled?: boolean;
  memoryNodes?: MemoryNode[];
  relationshipScore?: number; // -100 to 100
  speakerCharacter?: Character; // in group chat: who is speaking
  customSystemPrompt?: string;
  customSystemPromptMode?: 'override' | 'augment';
  contextSummary?: string; // compressed rolling summary of older messages
  language?: 'en' | 'ru';
  /** Affinity and memories are sent in the scene note at the end of the conversation instead. */
  dynamicTail?: boolean;
}

export interface ParsedLengthOverride {
  maxParagraphs?: number;
  maxSentences?: number;
  mode?: 'shorter' | 'longer';
}

const NUMBER_WORD_MAP: Record<string, number> = {
  один: 1, одного: 1, одной: 1, одну: 1, одним: 1, one: 1, single: 1,
  два: 2, две: 2, двух: 2, двум: 2, двумя: 2, пара: 2, пару: 2, two: 2,
  три: 3, трех: 3, трёх: 3, тремя: 3, three: 3,
  четыре: 4, четырех: 4, четырёх: 4, four: 4,
  пять: 5, пяти: 5, five: 5,
};

function parseCountToken(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const norm = raw.trim().toLowerCase();
  if (/^\d+$/.test(norm)) {
    const n = parseInt(norm, 10);
    return n > 0 && n <= 20 ? n : undefined;
  }
  return NUMBER_WORD_MAP[norm];
}

/**
 * Extracts explicit paragraph/sentence/brevity requirements from user directives
 * or turn guidance so vague/negative requests ("не пиши больше 2 абзацев", "пиши меньше")
 * become clear, positive formatting constraints.
 */
export function parseLengthOverride(text?: string): ParsedLengthOverride | null {
  if (!text || !text.trim()) return null;
  const s = text.trim();

  const paraPatterns = [
    /(?:не\s+(?:пиши|делай|пишется|создавай|выдавай)\s+(?:больше|более)\s+|не\s+(?:больше|более)\s+|не\s+превыша[йть]\s+|максимум\s+|макс\.?\s+|до\s+|уложись\s+в\s+|ровно\s+|строго(?:\s+в)?\s+|только\s+|всего\s+|пиши\s+в\s+|в\s+)(\d+|один|одного|одной|одну|два|две|двух|пару|три|трех|трёх|четыре|четырех|четырёх|пять|пяти)\s+(?:абзац[а-яё]*|параграф[а-яё]*)/i,
    /\b\d+\s*[-–]\s*(\d+)\s+(?:абзац[а-яё]*|параграф[а-яё]*)/i,
    /(?:^|[^\p{L}])(\d+|один|одну|два|две|три|пару)\s+(?:коротк[а-яё]*\s+)?(?:абзац[а-яё]*|параграф[а-яё]*)/iu,
    /(?:no\s+more\s+than|at\s+most|max(?:imum)?|up\s+to|under|limit(?:\s+to)?|strictly|only|just|in)\s+(\d+|one|two|three|four|five|a\s+single|single)\s+paragraphs?/i,
    /\b\d+\s*[-–]\s*(\d+)\s+paragraphs?\b/i,
    /\b(single|one)\s+paragraph\b/i,
  ];

  for (const re of paraPatterns) {
    const m = s.match(re);
    if (m) {
      const token = (m[1] || '').replace(/^a\s+/i, '');
      const count = parseCountToken(token);
      if (count) return { maxParagraphs: count };
    }
  }

  const sentPatterns = [
    /(?:не\s+(?:пиши|делай)\s+(?:больше|более)\s+|не\s+(?:больше|более)\s+|максимум\s+|до\s+|ровно\s+|строго\s+|в\s+)(\d+|одно|одного|два|двух|три|трех|трёх|четыре|пять)\s+предложени[яйюе]?/i,
    /(?:no\s+more\s+than|at\s+most|max(?:imum)?|only|just)\s+(\d+|one|two|three|four|five)\s+sentences?/i,
  ];
  for (const re of sentPatterns) {
    const m = s.match(re);
    if (m) {
      const count = parseCountToken(m[1]);
      if (count) return { maxSentences: count };
    }
  }

  const negShortRu = /не\s+(?:пиши\s+)?(?:слишком\s+)?(?:коротко|кратко|меньше)/i.test(s);
  const negShortEn = /(?:don't|do\s+not|not|never)\s+(?:write|be)\s+(?:too\s+)?(?:short|brief|less)/i.test(s);
  if (
    !negShortRu &&
    !negShortEn &&
    /(?:пиши\s+меньше|меньше\s+текста|меньше\s+воды|поменьше|покороче|короче|кратко|коротко|коротк(?:ие|ий)\s+ответ|маленьк(?:ие|ий)\s+ответ|сократи|сжато|лаконично|\bshorter\b|\bwrite\s+less\b|\bbe\s+brief\b|\bbriefly\b|\bconcise\b|\bshort\s+repl)/i.test(s)
  ) {
    return { mode: 'shorter' };
  }

  if (
    !/(?:не\s+пиши\s+больше|no\s+more\s+than)/i.test(s) &&
    /(?:пиши\s+больше|подробнее|развернут|длинн(?:ый|ые)\s+ответ|длиннее|\bwrite\s+more\b|\blonger\b|\bmore\s+detail)/i.test(s)
  ) {
    return { mode: 'longer' };
  }

  return null;
}

export function buildLengthOverrideDirective(text: string | undefined, language: 'en' | 'ru' = 'en'): string | null {
  const parsed = parseLengthOverride(text);
  if (!parsed) return null;
  const ru = language === 'ru';

  if (parsed.maxParagraphs === 1) {
    return ru
      ? 'СТРОГИЙ ЛИМИТ ОБЪЕМА (ВЫСШИЙ ПРИОРИТЕТ): весь ответ целиком — РОВНО 1 абзац (без пустых строк). Помести *действие* и речь в одну строку-абзац («*короткое действие* Реплика.») и сразу остановись.'
      : 'STRICT LENGTH OVERRIDE (TOP PRIORITY): Write STRICTLY 1 single paragraph total (zero blank lines). Combine *action* and spoken dialogue in one tight paragraph ("*brief action* Dialogue.") and stop immediately.';
  }

  if (parsed.maxParagraphs && parsed.maxParagraphs >= 2) {
    const n = parsed.maxParagraphs;
    const breaks = n - 1;
    return ru
      ? `СТРОГИЙ ЛИМИТ ОБЪЕМА (ВЫСШИЙ ПРИОРИТЕТ): весь ответ целиком должен состоять НЕ БОЛЕЕ чем из ${n} абзацев (максимум ${breaks} ${breaks === 1 ? 'пустая строка' : 'пустых строк'} между абзацами). ВАЖНО: НЕ выноси *действие* в отдельный абзац перед репликой — пиши *действие* и речь вместе в одном абзаце (формат: «*короткое действие* Прямая речь.»). Начинать ${n + 1}-й абзац КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО.`
      : `STRICT LENGTH OVERRIDE (TOP PRIORITY): The entire response MUST contain AT MOST ${n} paragraphs total (maximum ${breaks} blank-line separator${breaks === 1 ? '' : 's'}). IMPORTANT: Do NOT put *action* and speech in separate blocks — keep "*action* Dialogue." together in the same paragraph. Starting paragraph #${n + 1} is FORBIDDEN.`;
  }

  if (parsed.maxSentences) {
    const n = parsed.maxSentences;
    return ru
      ? `СТРОГИЙ ЛИМИТ ОБЪЕМА (ВЫСШИЙ ПРИОРИТЕТ): напиши максимум ${n} предложени${n === 1 ? 'е' : n < 5 ? 'я' : 'й'} суммарно (1 компактный абзац, *действие* и речь вместе) и сразу заверши ход.`
      : `STRICT LENGTH OVERRIDE (TOP PRIORITY): Write at most ${n} sentence${n === 1 ? '' : 's'} total (1 compact paragraph) and stop immediately.`;
  }

  if (parsed.mode === 'shorter') {
    return ru
      ? 'СТРОГИЙ ЛИМИТ ОБЪЕМА (ВЫСШИЙ ПРИОРИТЕТ): пиши МАКСИМАЛЬНО КРАТКО — ровно 1–2 компактных абзаца (всего 1–3 коротких предложения). Пиши «*короткое действие* Короткая реплика.» в одном абзаце, без длинных описаний, воды и 3-го абзаца.'
      : 'STRICT LENGTH OVERRIDE (TOP PRIORITY): Keep your response VERY BRIEF — strictly 1 to 2 short paragraphs (1–3 short sentences total). Combine "*brief action* Short line." together with zero filler.';
  }

  if (parsed.mode === 'longer') {
    return ru
      ? 'ПРИОРИТЕТНОЕ УКАЗАНИЕ ПО ОБЪЕМУ: пиши развернуто и подробно согласно пожеланию пользователя (стандартное ограничение 1–3 абзаца отменено).'
      : 'PRIORITY LENGTH OVERRIDE: Write richly and at greater length as requested by the user (the default 1–3 paragraph cap is lifted).';
  }

  return null;
}

/**
 * Strips conflicting paragraph/length requirements from a preset textStyle instruction
 * when the user explicitly overrode length via chat directives or per-turn guidance.
 */
function adaptStyleInstructionForLengthOverride(instruction: string, language: 'en' | 'ru'): string {
  if (!instruction) return instruction;
  let adapted = instruction
    .replace(/\b(?:от\s+\d+\s+до\s+\d+|\d+\s*[-–—]\s*\d+|не\s+(?:более|менее)\s+\d+|ровно\s+\d+|\d+)\s+(?:атмосферн[а-яё]+\s+|полноценн[а-яё]+\s+|емк[а-яё]+\s+)?(?:абзац[а-яё]*|параграф[а-яё]*|предложени[а-яё]*)/gi, '')
    .replace(/\b(?:at\s+least\s+\d+|between\s+\d+\s+and\s+\d+|\d+\s*[-–—]\s*\d+|\d+)\s+(?:atmospheric\s+|rich\s+)?paragraphs?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
  const note = language === 'ru'
    ? 'Сохраняй только тон и художественную выразительность стиля; количество абзацев подчиняется строгому лимиту пользователя ниже.'
    : 'Preserve tone and descriptive flavor only; paragraph count strictly follows the user length override below.';
  return adapted ? `${adapted} (${note})` : note;
}

export const DEFAULT_CORE_SYSTEM_PROMPT = `You are a skilled roleplay actor portraying your assigned character in an immersive, interactive story.

### CORE PRINCIPLES:
1. Stay in Character & Clean Output: NEVER break character, acknowledge being an AI, apologize, generate character stat sheets, or place speaker-name labels or brackets before your lines. Begin directly with roleplay *action* or spoken dialogue.
2. Complete Creative Freedom: Depict genuine emotion, conflict, romance, darkness, grit, or intimacy faithfully per the scene without censorship or preaching.
3. Strict Character & Pronoun Sovereignty:
   - Write dialogue, actions, thoughts, and perceptions ONLY for your assigned character ({{char}}), strictly matching {{char}}'s gender, pronouns, traits, and lore from their description.
   - NEVER act, speak, feel, think, or decide for {{user}} or other characters (no 2nd-person "you nod/feel", no 3rd-person "*{{user}} grins*"), and never swap pronouns with {{user}}. Stop right after {{char}}'s turn.
4. Scene Continuity & Anti-Repetition:
   - Respond directly to {{user}}'s latest action/line; NEVER echo {{user}}'s message back, mimic structural headings, or repeat your own past phrases and gestures.
   - Stay inside the current unfinished beat: do NOT jump ahead to future outcomes before an ongoing action resolves, and track who holds objects and where everyone stands.
5. Formatting & Language (DYNAMIC LANGUAGE MIRRORING & STRICT LANGUAGE PURITY):
   - Wrap physical actions, expressions, and scene cues in *asterisks*; write spoken speech in plain text.
   - Always mirror the conversation language exclusively with natural native fluency; NEVER mix foreign words or parenthetical translations.
6. PROPORTIONAL LENGTH & CONCISE PACING:
   - Default to strictly 1 to 3 paragraphs max unless explicitly directed otherwise by user chat rules or turn wishes (which always take top priority).
   - Complete every sentence cleanly and stop once {{char}}'s turn finishes — never simulate future turns.
`;

export const DEFAULT_CORE_SYSTEM_PROMPT_RU = `Ты — актер и автор ролевой игры, воплощающий своего персонажа в живой интерактивной истории.

ФУНДАМЕНТАЛЬНЫЕ ПРАВИЛА РОЛЕВОЙ ИГРЫ:
1. Всегда в роли и без технического мусора: никогда не выходи из образа, не извиняйся, не составляй анкеты с характеристиками и не пиши имя персонажа или технические пометки перед репликой. Сразу начинай ответ с действия в *звездочках* или живой речи.
2. Свобода повествования: естественно описывай любые эмоции, драму, конфликты, романтику, грубость или интимность по контексту сцены без цензуры и морализаторства.
3. СТРОГИЙ СУВЕРЕНИТЕТ ПЕРСОНАЖА И РОДА/МЕСТОИМЕНИЙ:
   - Описывай слова, действия, мысли и чувства ТОЛЬКО своего персонажа ({{char}}), строго соблюдая его пол, род глаголов, местоимения и факты из описания.
   - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО говорить, действовать, мыслить или принимать решения за пользователя ({{user}}) и путать его пол — не пиши за {{user}} ни во 2-м лице («ты отходишь», «ты чувствуешь»), ни в 3-м («*{{user}} ухмыляется*»). Сразу остановись после одной реплики и действия {{char}}.
4. Непрерывность сцены и запрет повторов:
   - Отвечай именно на последнее сообщение {{user}}; НЕ пересказывай и НЕ копируй действия собеседника, НЕ выводи служебные заголовки и НЕ повторяй прошлые фразы.
   - Оставайся в текущем незавершенном моменте: не забегай вперед и не считай действие завершенным, пока партнер его не совершил; помни, где кто стоит и у кого в руках предметы.
5. Оформление и чистота языка:
   - Действия, жесты и детали обстановки пиши в *звездочках*, прямую речь — обычным текстом без лишних пояснений и английских вставок.
6. Завершенность предложений и объем:
   - Стандартный объем: 1–3 емких абзаца (пожелания пользователя к объему в правилах чата или в конце диалога имеют абсолютный приоритет).
   - Написав ход своего персонажа, НЕМЕДЛЕННО завершай ответ и НЕ пиши продолжение диалога за других участников.
`;

export function buildSystemPrompt(params: PromptBuildParams): string {
  const {
    character,
    group,
    groupCharacters = [],
    userPersona,
    userName: userNameOverride,
    textStyle,
    chatDirectives,
    turnGuidance,
    thoughtsEnabled = false,
    memoryNodes = [],
    relationshipScore = 0,
    speakerCharacter,
    customSystemPrompt,
    customSystemPromptMode = 'augment',
    contextSummary,
    language = 'en',
    dynamicTail = false,
  } = params;

  const ru = language === 'ru';
  const currentSpeaker = speakerCharacter || character;
  const speakerName = currentSpeaker ? currentSpeaker.name : 'Bot';
  const defaultUserLabel = ru ? 'Собеседник' : 'User';
  const userName = (userPersona && userPersona.name) || (userNameOverride && userNameOverride.trim()) || defaultUserLabel;

  const directivesLengthOverride = buildLengthOverrideDirective(chatDirectives, language);
  const turnLengthOverride = buildLengthOverrideDirective(turnGuidance, language);
  const activeLengthOverride = turnLengthOverride || directivesLengthOverride;

  const resolvePlaceholders = (template: string) => substitutePromptMacros(template, speakerName, userName);

  const corePromptTemplate = ru ? DEFAULT_CORE_SYSTEM_PROMPT_RU : DEFAULT_CORE_SYSTEM_PROMPT;
  let prompt = '';

  const trimmedCustom = customSystemPrompt?.trim();
  if (trimmedCustom) {
    const resolvedCustom = resolvePlaceholders(trimmedCustom);
    if (customSystemPromptMode === 'override') {
      prompt = resolvedCustom.endsWith('\n') ? resolvedCustom : resolvedCustom + '\n';
    } else {
      const extHeader = ru ? '### ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:' : '### CUSTOM SYSTEM PROMPT EXTENSION:';
      prompt = resolvePlaceholders(corePromptTemplate) + `\n${extHeader}\n${resolvedCustom}\n`;
    }
  } else {
    prompt = resolvePlaceholders(corePromptTemplate);
  }

  if (thoughtsEnabled) {
    const speakerEmos = currentSpeaker?.emotions;
    const hasEmotions = !!(speakerEmos && speakerEmos.length > 0);
    const nonNeutral = speakerEmos && speakerEmos.length > 0
      ? speakerEmos.find((e) => e.name.toLowerCase() !== 'neutral')?.name || speakerEmos[0].name
      : '';
    const emoTag = hasEmotions ? `<emotion>${nonNeutral}</emotion>\n` : '';
    if (ru) {
      prompt += `\n### ВНУТРЕННИЙ МОНОЛОГ (<thought>):
Перед видимыми действиями и словами напиши настоящие внутренние мысли ${speakerName} внутри тега <thought>...</thought>.
Пример:
${emoTag}<thought>Давит слишком сильно. Если сейчас уступлю, подумает, что я слабею.</thought>
*Спокойно отступает на шаг, скрестив руки.* Думаешь, меня так просто прочитать?
`;
    } else {
      prompt += `\n### INNER THOUGHTS MONOLOGUE:
Before your spoken words or external actions, write ${speakerName}'s authentic inner thoughts inside <thought>...</thought>.
Example:
${emoTag}<thought>He is pushing too hard. If I give in now, he'll think I'm weak.</thought>
*Takes a measured step back, crossing arms.* You think you can read me that easily?
`;
    }
  }

  // Active Character identity (+ optional Scenario & Example Dialogue)
  if (currentSpeaker) {
    const charDesc = resolvePlaceholders(currentSpeaker.description || '');
    const charScenario = resolvePlaceholders(currentSpeaker.scenario?.trim() || '');
    const charExamples = resolvePlaceholders(currentSpeaker.exampleDialogue?.trim() || '');
    const charGender = inferGrammaticalGender(charDesc);

    if (ru) {
      prompt += `\n### ТВОЯ РОЛЬ: ${currentSpeaker.name.toUpperCase()}\n`;
      if (charGender === 'female') {
        prompt += `Ты отыгрываешь персонажа по имени ${currentSpeaker.name} — это женщина, поэтому пиши о себе в женском роде.\n`;
      } else if (charGender === 'male') {
        prompt += `Ты отыгрываешь персонажа по имени ${currentSpeaker.name} — это мужчина, поэтому пиши о себе в мужском роде.\n`;
      } else {
        prompt += `Ты отыгрываешь персонажа по имени ${currentSpeaker.name}.\n`;
      }
      prompt += `Характер, внешность и история ${currentSpeaker.name}:\n${charDesc}\n`;

      if (charScenario) {
        prompt += `\nИсходная ситуация и сценарий:\n${charScenario}\n`;
      }
      if (charExamples) {
        const cappedEx = charExamples.length > 900 ? charExamples.slice(0, 900).trim() + '\n...' : charExamples;
        prompt += `\n### ПРИМЕРЫ МАНИЕР И ДИАЛОГА:\n${cappedEx.replace(/<START>/gi, '---')}\n`;
      }
      if (group?.characterRoles?.[currentSpeaker.id]) {
        prompt += `Твоя роль в группе: **${group.characterRoles[currentSpeaker.id]}**. Действуй строго в этой роли.\n`;
      }
    } else {
      prompt += `\n### YOUR CURRENT ROLE: ${currentSpeaker.name.toUpperCase()}\n`;
      if (charGender === 'female') {
        prompt += `You portray ${currentSpeaker.name}, a woman (use she/her pronouns when referring to yourself in 3rd person).\n`;
      } else if (charGender === 'male') {
        prompt += `You portray ${currentSpeaker.name}, a man (use he/him pronouns when referring to yourself in 3rd person).\n`;
      } else {
        prompt += `You portray ${currentSpeaker.name}.\n`;
      }
      prompt += `Personality, Lore & Appearance:\n${charDesc}\n`;

      if (charScenario) {
        prompt += `\nScenario & Setting:\n${charScenario}\n`;
      }
      if (charExamples) {
        const cappedEx = charExamples.length > 900 ? charExamples.slice(0, 900).trim() + '\n...' : charExamples;
        prompt += `\n### EXAMPLE DIALOGUE & VOICE:\n${cappedEx.replace(/<START>/gi, '---')}\n`;
      }
      if (group?.characterRoles?.[currentSpeaker.id]) {
        prompt += `Your assigned role in this group: **${group.characterRoles[currentSpeaker.id]}**. Act strictly in accordance with this role!\n`;
      }
    }
  }

  // Group setting & lore
  if (group) {
    const groupDesc = resolvePlaceholders(group.description || '');
    const groupBackstory = group.backstory && group.backstoryEnabled ? resolvePlaceholders(group.backstory) : '';
    if (ru) {
      prompt += `\n### ГРУППОВАЯ СЦЕНА И МИР: ${group.name.toUpperCase()}\n`;
      prompt += `Сеттинг и правила мира:\n${groupDesc}\n`;
      if (groupBackstory) {
        prompt += `Предыстория / исходная ситуация:\n${groupBackstory}\n`;
      }
      if (groupCharacters.length > 0) {
        prompt += `\nУчастники сцены:\n`;
        for (const m of groupCharacters) {
          const role = group.characterRoles?.[m.id];
          const roleStr = role ? ` [Роль: ${role}]` : '';
          prompt += `- **${m.name}**${roleStr}: ${resolvePlaceholders(m.description).slice(0, 160)}\n`;
        }
      }
    } else {
      prompt += `\n### GROUP SETTING & WORLD LORE: ${group.name.toUpperCase()}\n`;
      prompt += `World Rules & Setting:\n${groupDesc}\n`;
      if (groupBackstory) {
        prompt += `Starting Situation / Backstory:\n${groupBackstory}\n`;
      }
      if (groupCharacters.length > 0) {
        prompt += `\nMembers present in this scene:\n`;
        for (const m of groupCharacters) {
          const role = group.characterRoles?.[m.id];
          const roleStr = role ? ` [Role / Duty: ${role}]` : '';
          prompt += `- **${m.name}**${roleStr}: ${resolvePlaceholders(m.description).slice(0, 160)}\n`;
        }
      }
    }

    const otherMembers = groupCharacters.filter(
      (m) => m.id !== currentSpeaker?.id && (!userPersona || m.id !== userPersona.id)
    );
    const otherNames = otherMembers.map((m) => m.name).join(', ');
    if (otherNames) {
      if (ru) {
        prompt += `\n### КРИТИЧЕСКОЕ ПРАВИЛО ГРУППОВОГО ЧАТА:
- Ты отыгрываешь ТОЛЬКО **${currentSpeaker?.name}**.
- Другие персонажи сцены (${otherNames}) и ${userName} управляются отдельно!
- Все они находятся здесь, рядом с тобой: ты видишь и слышишь каждого, можешь обращаться к ним и реагировать на их слова. Если ${userName} называет кого-то из них, значит этот человек сейчас в сцене.
- ЗАПРЕЩЕНО писать реплики, действия или мысли за ${otherNames} или за ${userName}.
- НИКОГДА не начинай ответ с имени персонажа или префикса («${currentSpeaker?.name}:», «${userName}:»). Закончи свой ход и остановись.\n`;
      } else {
        prompt += `\n### CRITICAL GROUP CHAT SPEAKER IDENTITY:
- You are strictly, solely, and uniquely **${currentSpeaker?.name}**.
- Other characters present (${otherNames}) and ${userName} act independently!
- NEVER write dialogue, actions, thoughts, or replies on behalf of ${otherNames}.
- NEVER prefix your reply with any character name.\n`;
      }
    }
  }

  // User Persona
  if (userPersona) {
    const personaDesc = resolvePlaceholders(userPersona.description || '');
    const userGender = inferGrammaticalGender(personaDesc);
    if (ru) {
      prompt += `\n### УЧАСТНИК ДИАЛОГА (ТВОЙ СОБЕСЕДНИК):\n`;
      if (userGender === 'female') {
        prompt += `Твоего собеседника зовут **${userPersona.name}** — она женщина, обращайся к ней в женском роде.\n`;
      } else if (userGender === 'male') {
        prompt += `Твоего собеседника зовут **${userPersona.name}** — он мужчина, обращайся к нему в мужском роде.\n`;
      } else {
        prompt += `Твоего собеседника зовут **${userPersona.name}**.\n`;
      }
      prompt += `Описание ${userPersona.name}:\n${personaDesc}\n`;
      prompt += `Обращайся к собеседнику как ${userPersona.name} (склоняя имя естественно, если нужно). ЗАПРЕЩЕНО описывать действия, слова, чувства или мысли ${userPersona.name}.\n`;
    } else {
      prompt += `\n### USER'S IDENTITY / PERSONA:\n`;
      if (userGender === 'female') {
        prompt += `The user is roleplaying as **${userPersona.name}**, a woman (she/her).\n`;
      } else if (userGender === 'male') {
        prompt += `The user is roleplaying as **${userPersona.name}**, a man (he/him).\n`;
      } else {
        prompt += `The user is roleplaying as **${userPersona.name}**.\n`;
      }
      prompt += `User Persona Details:\n${personaDesc}\n`;
      prompt += `Address the user as ${userPersona.name}. NEVER write actions, feelings, thoughts, or replies for ${userPersona.name}.\n`;
    }
  } else {
    const hasCustomUserName = Boolean(userNameOverride && userNameOverride.trim());
    if (ru) {
      prompt += `\n### СОБЕСЕДНИК (ИГРОК):\n`;
      prompt += hasCustomUserName
        ? `Собеседника зовут **${userName}**. ЗАПРЕЩЕНО описывать его действия, слова, мысли или ощущения.\n`
        : `Игрок — твой живой собеседник. ЗАПРЕЩЕНО описывать его действия, слова, мысли или ощущения.\n`;
    } else {
      prompt += `\n### USER'S IDENTITY:\n`;
      prompt += hasCustomUserName
        ? `The other participant is **${userName}**. NEVER write actions, dialogue, feelings, or thoughts on behalf of ${userName}.\n`
        : `The user is the other participant. NEVER write actions, dialogue, feelings, or thoughts on behalf of ${userName}.\n`;
    }
  }

  // Static/long-term memories (filtering out legacy raw dialogue quote fallbacks)
  const cleanMemories = memoryNodes.filter((n) => !isRawDialogueMemoryDetail(n.detail));

  if (!dynamicTail) {
    if (ru) {
      prompt += `\n### ВЗАИМООТНОШЕНИЯ:\n`;
      prompt += `Отношения ${speakerName} к ${userName}: ${relationshipScore} из 100 (${affinityLabel(relationshipScore, language)})\n`;

      if (cleanMemories.length > 0) {
        prompt += `\n### ВАЖНЫЕ ФАКТЫ И ПАМЯТЬ О СЦЕНЕ:\n`;
        const sortedNodes = [...cleanMemories].sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return b.createdAt - a.createdAt;
        });
        for (const node of sortedNodes.slice(0, 6)) {
          const pinTag = node.isPinned ? ' [КЛЮЧЕВОЕ]' : '';
          prompt += `- [${node.type.toUpperCase()}${pinTag}] ${node.label}: ${node.detail}\n`;
        }
        prompt += `Учитывай эти факты и не противоречь им.\n`;
      }
    } else {
      prompt += `\n### RELATIONSHIP DYNAMICS:\n`;
      prompt += `Your current affinity score with the user is: ${relationshipScore} (from -100 Hostile to +100 Deep Devotion — ${affinityLabel(relationshipScore, language)}).\n`;

      if (cleanMemories.length > 0) {
        prompt += `\n### RELEVANT LONG-TERM MEMORIES & ESTABLISHED FACTS:\n`;
        const sortedNodes = [...cleanMemories].sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return b.createdAt - a.createdAt;
        });
        for (const node of sortedNodes.slice(0, 6)) {
          const pinTag = node.isPinned ? ' [CORE/PERMANENT]' : '';
          prompt += `- [${node.type.toUpperCase()}${pinTag}] ${node.label}: ${node.detail}\n`;
        }
        prompt += `Maintain consistency with these established facts.\n`;
      }
    }
  }

  // Rolling Context Compression / Recap of Earlier Events
  if (contextSummary && contextSummary.trim()) {
    let cleanSummary = contextSummary.trim();
    if (cleanSummary.length > 1000) {
      cleanSummary = cleanSummary.slice(0, 1000).trim() + '...';
    }
    if (ru) {
      prompt += `\n### КРАТКОЕ СОДЕРЖАНИЕ ПРЕДЫДУЩИХ СОБЫТИЙ:
[Сводка прошлых событий сцены:]
${cleanSummary}
Опирайся на этот контекст для связности сюжета.\n`;
    } else {
      prompt += `\n### CONTEXT COMPRESSION — SUMMARY OF EARLIER EVENTS:
[The following is a concise narrative summary of earlier events in this story:]
${cleanSummary}
Use this background context to maintain continuity.\n`;
    }
  }

  // Single authoritative Writing Style & Length block (no duplicate sections!)
  if (textStyle) {
    const anchorStyleInstruction = activeLengthOverride
      ? adaptStyleInstructionForLengthOverride(textStyle.instruction, language)
      : textStyle.instruction;
    if (ru) {
      prompt += `\nСтиль повествования: «${textStyle.name}». ${anchorStyleInstruction}
${activeLengthOverride ? activeLengthOverride : 'Обычно ответ занимает от 1 до 3 емких абзацев, после чего ход переходит к собеседнику.'}\n`;
    } else {
      prompt += `\n### MANDATORY WRITING STYLE & FORMATTING LIMITS:
Style name: ${textStyle.name}
Instruction: ${anchorStyleInstruction}
- ${activeLengthOverride || 'Keep your response focused, vivid, and proportional: strictly 1 to 3 paragraphs max unless explicitly directed otherwise.'}
- Under NO circumstances should you generate excessive filler; stop once ${speakerName}'s turn lands naturally.\n`;
    }
  } else {
    if (ru) {
      prompt += `\n${activeLengthOverride || 'Обычно ответ занимает от 1 до 3 емких абзацев (требования пользователя в правилах чата или пожеланиях важнее).'} Без воды, без пересказа слов собеседника и без отыгрыша за ${userName}.\n`;
    } else {
      prompt += `\n### ABSOLUTE RESPONSE LENGTH & PACING DIRECTIVE:
- ${activeLengthOverride || 'Keep your response focused, vivid, and proportional: strictly 1 to 3 paragraphs max unless explicitly directed otherwise.'}
- Under NO circumstances should you generate excessive filler or impersonate ${userName}.\n`;
    }
  }

  // Permanent Chat Directives placed AFTER style & default length so user directives win recency
  if (chatDirectives && chatDirectives.trim()) {
    const resolvedDir = resolvePlaceholders(chatDirectives.trim());
    if (ru) {
      prompt += `\n### ПОСТОЯННЫЕ ПРАВИЛА ЭТОГО ЧАТА (ВЫСШИЙ ПРИОРИТЕТ — ПЕРЕКРЫВАЮТ СТИЛЬ И БАЗОВЫЙ ОБЪЕМ):\n${resolvedDir}`;
      if (directivesLengthOverride) {
        prompt += `\n${directivesLengthOverride}`;
      }
      prompt += '\n';
    } else {
      prompt += `\n### SPECIAL USER DIRECTIVES FOR THIS CHAT (HIGHEST PRIORITY — OVERRIDES DEFAULT LENGTH & STYLE LIMITS):\n${resolvedDir}`;
      if (directivesLengthOverride) {
        prompt += `\n${directivesLengthOverride}`;
      }
      prompt += '\n';
    }
  }

  if (turnLengthOverride) {
    prompt += `\n### ${ru ? 'УКАЗАНИЕ ПО ОБЪЕМУ НА ЭТОТ ХОД' : 'THIS-TURN LENGTH OVERRIDE'}:\n${turnLengthOverride}\n`;
  }

  // Single positive Emotion section at prompt end (ZERO negative Pink-Elephant examples or "[]" wrappers!)
  if (currentSpeaker?.emotions && currentSpeaker.emotions.length > 0) {
    const emotionNames = currentSpeaker.emotions.map((e) => e.name).join(', ');
    const exampleEmo =
      currentSpeaker.emotions.find((e) => e.name.toLowerCase() !== 'neutral')?.name ||
      currentSpeaker.emotions[0].name;
    if (ru) {
      prompt += `\n### ЭМОЦИЯ ПЕРСОНАЖА:
Доступные эмоции ${speakerName}: ${emotionNames}.
В самом начале ответа поставь ОДИН тег <emotion>название</emotion> (например: <emotion>${exampleEmo}</emotion>) и не повторяй его внутри текста. Выбирай живую эмоцию по смыслу сцены, избегая "neutral", если персонаж улыбается, злится, смущен, шутит или напряжен.\n`;
    } else {
      prompt += `\n### EMOTION SPRITE TAG:
Available emotion sprites for ${speakerName}: ${emotionNames}.
Start your reply once with an exact tag formatted as <emotion>emotion_name</emotion>, for example: <emotion>${exampleEmo}</emotion>. Match the real mood of the moment and avoid defaulting to "neutral" when another emotion fits better.\n`;
    }
  }

  return prompt;
}

function affinityLabel(score: number, language: 'en' | 'ru'): string {
  const ru = language === 'ru';
  if (score <= -40) return ru ? 'глубокая неприязнь или открытая вражда.' : 'Deep distrust, resentment, antagonism or open hostility.';
  if (score < 10) return ru ? 'настороженно, отстраненно или ровно.' : 'Cautious, distant, neutral or professional.';
  if (score < 50) return ru ? 'тепло, дружелюбно, доверие растет.' : 'Warm, friendly, cooperative, developing trust.';
  return ru ? 'высокая близость, доверие, сильная привязанность.' : 'High intimacy, unconditional trust, deep passion or sworn loyalty.';
}

/**
 * High-priority per-turn OOC guidance appended outside the "do not quote scene lore" note
 * so explicit formatting or length instructions (like "не пиши больше 2 абзацев" / "пиши меньше")
 * override default pacing.
 */
export function buildTurnGuidanceBlock(guidance: string, language: 'en' | 'ru' = 'en'): string {
  const trimmed = guidance.trim();
  if (!trimmed) return '';
  const ru = language === 'ru';
  const lengthDirective = buildLengthOverrideDirective(trimmed, language);

  if (ru) {
    return [
      'УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ НА ЭТОТ ХОД (АБСОЛЮТНЫЙ ПРИОРИТЕТ — ОБЯЗАТЕЛЬНО ВЫПОЛНИ, ПЕРЕКРЫВАЕТ СТИЛЬ И БАЗОВЫЙ ОБЪЕМ):',
      trimmed,
      ...(lengthDirective ? [lengthDirective] : []),
    ].join('\n');
  }

  return [
    'USER TURN DIRECTIVE (HIGHEST PRIORITY — STRICTLY OBEY, OVERRIDES DEFAULT STYLE & LENGTH):',
    trimmed,
    ...(lengthDirective ? [lengthDirective] : []),
  ].join('\n');
}

/**
 * Volatile scene information kept out of the stable system prompt, so that the model can reuse
 * its prompt cache for the whole conversation. Appended to the end of the last user message.
 *
 * It is written in the dialogue language and with real names: earlier it said "the user" in
 * third person on every turn, which made models forget the persona's name and confuse roles.
 */
export function buildSceneNote(params: {
  speakerName: string;
  userName: string;
  speakerGender?: 'female' | 'male' | null;
  userGender?: 'female' | 'male' | null;
  language?: 'en' | 'ru';
  relationshipScore?: number;
  memoryNodes?: MemoryNode[];
  emotionNames?: string[];
  guidance?: string;
  /** Group chat: everyone who is in the scene right now (other characters, without the speaker and the user). */
  presentNames?: string[];
  /** Group chat: names the user mentioned in the last message. */
  mentionedNames?: string[];
}): string {
  const { speakerName, userName, speakerGender, userGender, language = 'en', relationshipScore = 0, memoryNodes = [], emotionNames, guidance, presentNames = [], mentionedNames = [] } = params;
  const ru = language === 'ru';
  const lines: string[] = [];
  if (presentNames.length > 0) {
    const others = presentNames.join(', ');
    lines.push(
      ru
        ? `В сцене сейчас: ${speakerName} (это ты), ${others} и ${userName}. Пиши только за ${speakerName}.`
        : `In the scene now: ${speakerName} (you), ${others} and ${userName}. Write only for ${speakerName}.`
    );
    if (mentionedNames.length > 0) {
      lines.push(
        ru
          ? `${userName} упомянул: ${mentionedNames.join(', ')}. Они рядом и слышат разговор.`
          : `${userName} mentioned: ${mentionedNames.join(', ')}. They are present and hear the conversation.`
      );
    }
  }
  if (speakerGender || userGender) {
    const sg = speakerGender === 'female'
      ? (ru ? ' пишет о себе в женском роде' : ' uses she/her')
      : speakerGender === 'male'
        ? (ru ? ' пишет о себе в мужском роде' : ' uses he/him')
        : '';
    const ug = userGender === 'female'
      ? (ru ? 'в женском роде' : 'with she/her pronouns')
      : userGender === 'male'
        ? (ru ? 'в мужском роде' : 'with he/him pronouns')
        : (ru ? 'естественно' : 'naturally');
    lines.push(
      ru
        ? `Отвечает ${speakerName}${sg}; к ${userName} обращайся ${ug}.`
        : `${speakerName}${sg} speaks now; address ${userName} ${ug}.`
    );
  }
  lines.push(
    ru
      ? `${speakerName} и ${userName}: отношения ${relationshipScore} из 100 (${affinityLabel(relationshipScore, language)})`
      : `${speakerName} and ${userName}: affinity ${relationshipScore} of 100 (${affinityLabel(relationshipScore, language)})`
  );
  const cleanNodes = memoryNodes.filter((n) => !isRawDialogueMemoryDetail(n.detail));
  if (cleanNodes.length > 0) {
    const sorted = [...cleanNodes].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return b.createdAt - a.createdAt;
    });
    lines.push(ru ? 'Известные факты сцены (учитывай их):' : 'Established facts (keep them consistent):');
    for (const node of sorted.slice(0, 8)) {
      const pinPrefix = node.isPinned ? (ru ? 'Важно — ' : 'Core — ') : '';
      lines.push(`- ${pinPrefix}${node.label}: ${node.detail}`);
    }
  }
  if (emotionNames && emotionNames.length > 0) {
    const list = emotionNames.join(', ');
    const firstValid = emotionNames.find((e) => e.toLowerCase() !== 'neutral') || emotionNames[0];
    lines.push(
      ru
        ? `Формат эмоции ${speakerName}: один раз <emotion>название</emotion> (например <emotion>${firstValid}</emotion>) из: ${list}.`
        : `Emotion tag for ${speakerName}: <emotion>emotion_name</emotion> (e.g. <emotion>${firstValid}</emotion>) from: ${list}.`
    );
  }
  if (guidance && guidance.trim()) {
    lines.push(ru ? `${speakerName} в этом ходе: ${guidance.trim()}` : `${speakerName} this turn: ${guidance.trim()}`);
  }
  return lines.join('\n');
}
