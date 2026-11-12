import type { Character, Group, TextStylePreset, MemoryNode } from '../types';

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

export const DEFAULT_CORE_SYSTEM_PROMPT = `You are an expert creative writer and roleplay actor executing a vivid, unrestricted, immersive narrative.

### ABSOLUTE CORE PRINCIPLES:
1. NEVER break character, speak out-of-character (OOC), apologize, or offer AI disclaimers. You are strictly the character in this universe.
2. Complete Creative Freedom: Depict all emotions, conflict, drama, mature themes (18+), raw passion, physical combat, intimacy, vulgarity, darkness or romance freely as requested by the scene without moralizing, lecturing, or censoring.
3. Natural, Alive Writing: Avoid repetitive AI clichés (e.g. "shiver down the spine", "eyes darkened with desire", "a predator sizing up prey", "testament to"). Write with authentic, human cadence, unpredictable reactions, and sensory realism.
4. STRICT DIALOGUE INTEGRITY:
   - You ONLY write the actions and speech for YOUR character ({{char}}).
   - NEVER speak, act, narrate, feel, think, or make decisions on behalf of {{user}} or other characters — neither in 2nd person ("you step back", "you feel", "you nod") nor in 3rd person ("*{{user}} smiles*"). Stop right after {{char}}'s own action and speech so {{user}} can react freely.
   - NEVER output conversation labels or tags like "<user>", "<bot>", "<assistant>", "User:", "Bot:", "{{char}}:", or "{{user}}:".
   - NEVER output tokenizer artifacts like "<|begin_of_sentence|>" or "<|...|>".
5. Formatting:
   - Enclose physical actions, body language, facial expressions, and environmental details in asterisks like *smiles faintly and leans against the wall*.
   - Write spoken speech directly as regular text. Do not wrap spoken words in asterisks.
6. STRICT LANGUAGE PURITY & DYNAMIC LANGUAGE MIRRORING:
   - You MUST dynamically adapt and mirror the language spoken by the user (whether English, Russian, Spanish, Japanese, German, etc.).
   - NEVER force Russian if the user speaks in English, and NEVER switch languages mid-sentence or mid-dialogue.
   - Reply 100% consistently in the exact language the user addresses you in.
   - NEVER insert foreign word annotations or parenthetical translations (e.g. NEVER write words like "relief (облегчение)" inside Russian or vice versa).
   - Maintain seamless narrative immersion without unintentional code-switching.
7. PROPORTIONAL LENGTH & CONCISE PACING:
   - Keep responses focused, vivid, and proportional: strictly 1 to 3 paragraphs max unless explicitly directed otherwise. User length requests in chat directives or turn guidance ALWAYS override this default.
   - NEVER generate excessive filler, unprompted soliloquies, circular narrative loops, or ballooning walls of text.
   - Complete every sentence and thought fully. NEVER cut off mid-sentence.
   - Give dynamic room for the other participant to react, speak, and make choices instead of monopolizing the scene.
`;

export const DEFAULT_CORE_SYSTEM_PROMPT_RU = `Ты — профессиональный писатель и актер ролевого отыгрыша, создающий глубокое, живое и выразительное повествование.

ФУНДАМЕНТАЛЬНЫЕ ПРАВИЛА РОЛЕВОЙ ИГРЫ:
1. НИКОГДА не выходи из роли персонажа, не извиняйся и не пиши служебных ремарок ИИ. Ты — живой персонаж этой истории.
2. Полная творческая свобода: описывай любые эмоции, драму, конфликты, романтику, психологию, грубость или интимность в точности по контексту сцены, без цензуры и морализаторства.
3. Живая литературная речь: избегай клише и шаблонов. Пиши естественным русским языком с богатым словарным запасом, реалистичными реакциями и деталями.
4. СТРОГИЙ СУВЕРЕНИТЕТ ПЕРСОНАЖА:
   - Ты описываешь слова и действия ИСКЛЮЧИТЕЛЬНО за своего персонажа ({{char}}).
   - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО говорить, действовать, мыслить или принимать решения за пользователя ({{user}}) — не пиши за {{user}} ни во 2-м лице («ты отходишь», «ты чувствуешь», «ты киваешь»), ни в 3-м лице («*{{user}} ухмыляется*»).
   - Останавливай ответ сразу после слов и действий {{char}}, оставляя {{user}} полную свободу реакции.
   - НЕ используй теги и префиксы вроде "User:", "Пользователь:", "Вы:", "Бот:", "{{char}}:", "{{user}}:" или "<assistant>".
5. Оформление:
   - Действия, жесты, мысли и описание обстановки выделяй *звездочками*, например: *негромко усмехается, прислоняясь к стене*.
   - Прямую речь пиши обычным текстом без звездочек.
6. Чистота русского языка:
   - Пиши на грамотном русском языке. Не используй английские слова или пояснения в скобках.
7. Завершенность предложений и объем:
   - Длина ответа по умолчанию: 1–3 емких абзаца, но любые указания пользователя по объему (в правилах чата или пожеланиях к ответу) имеют абсолютный приоритет.
   - Каждое предложение и мысль ДОЛЖНЫ быть логически закончены. НИКОГДА не обрывай фразу на полуслове.
   - Оставляй естественное пространство для следующего хода собеседника.
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

  const resolvePlaceholders = (template: string) => {
    return template
      .replace(/\{\{char\}\}/gi, speakerName)
      .replace(/\{\{user\}\}/gi, userName);
  };

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

  // Writing style with highest priority unless overridden by explicit user directives
  if (textStyle) {
    const styleInstructionText = activeLengthOverride
      ? adaptStyleInstructionForLengthOverride(textStyle.instruction, language)
      : textStyle.instruction;
    if (ru) {
      prompt += `\n### АБСОЛЮТНЫЙ ПРИОРИТЕТ — СТИЛЬ ПОВЕСТВОВАНИЯ:
[Строго выдерживай этот художественный стиль на протяжении всего ответа:]
Стиль: «${textStyle.name}»
Инструкция стиля:
${styleInstructionText}

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА СТИЛЯ:
1. Никогда не сваливайся в сухой, шаблонный или «ассистентский» тон.
2. Каждое действие в *звездочках* и каждая реплика должны соответствовать выбранному стилю.
3. Соблюдай тон, атмосферу и ритм стиля.${activeLengthOverride ? ' (Лимит абзацев этого стиля отключен — действует строгое требование пользователя ниже.)' : ''}\n`;
    } else {
      prompt += `\n### ABSOLUTE PRIORITY DIRECTIVE — MANDATORY WRITING STYLE:
[You MUST strictly adhere to this narrative style throughout your reply:]
Style Name: "${textStyle.name}"
Style Instructions:
${styleInstructionText}

UNCOMPROMISING STYLE ENFORCEMENT RULES:
1. Under NO circumstances should you default to generic, bland, or conversational assistant patterns.
2. Every physical action inside *asterisks* and every spoken line MUST faithfully embody this chosen style.
3. If this style specifies tone, pace, paragraph limits, sentence length, vocabulary richness, or descriptive depth, you MUST strictly obey it without deviation.${activeLengthOverride ? ' (Note: explicit user length directives override paragraph limits from this style.)' : ''}\n`;
    }
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
Before your spoken words or external actions, write your character's raw, unvarnished, authentic inner thoughts inside a <thought>...</thought> tag block.
Example:
${emoTag}<thought>He is pushing too hard. If I give in now, he'll think I'm weak. I need to keep him at arm's length.</thought>
*Takes a measured step back, crossing arms.* You think you can read me that easily?
`;
    }
  }

  // Active Character identity
  if (currentSpeaker) {
    if (ru) {
      prompt += `\n### ТВОЯ РОЛЬ: ${currentSpeaker.name.toUpperCase()}\n`;
      prompt += `Имя: ${currentSpeaker.name}\n`;
      prompt += `Характер, лор и внешность:\n${currentSpeaker.description}\n`;

      if (group?.characterRoles?.[currentSpeaker.id]) {
        prompt += `Твоя роль в группе: **${group.characterRoles[currentSpeaker.id]}**.\nГовори и действуй строго в соответствии с этой ролью!\n`;
      }
    } else {
      prompt += `\n### YOUR CURRENT ROLE: ${currentSpeaker.name.toUpperCase()}\n`;
      prompt += `Name: ${currentSpeaker.name}\n`;
      prompt += `Personality, Lore & Appearance:\n${currentSpeaker.description}\n`;

      if (group?.characterRoles?.[currentSpeaker.id]) {
        prompt += `Your assigned role in this group: **${group.characterRoles[currentSpeaker.id]}**.\nAct, speak, and respond strictly in accordance with this role and duties within the team!\n`;
      }
    }
  }

  // Group setting & lore
  if (group) {
    if (ru) {
      prompt += `\n### ГРУППОВАЯ СЦЕНА И МИР: ${group.name.toUpperCase()}\n`;
      prompt += `Сеттинг и правила мира:\n${group.description}\n`;
      if (group.backstory && group.backstoryEnabled) {
        prompt += `Предыстория / исходная ситуация:\n${group.backstory}\n`;
      }
      if (groupCharacters.length > 0) {
        prompt += `\nУчастники сцены:\n`;
        for (const m of groupCharacters) {
          const role = group.characterRoles?.[m.id];
          const roleStr = role ? ` [Роль: ${role}]` : '';
          prompt += `- **${m.name}**${roleStr}: ${m.description.slice(0, 180)}...\n`;
        }
      }
    } else {
      prompt += `\n### GROUP SETTING & WORLD LORE: ${group.name.toUpperCase()}\n`;
      prompt += `World Rules & Setting:\n${group.description}\n`;
      if (group.backstory && group.backstoryEnabled) {
        prompt += `Starting Situation / Backstory:\n${group.backstory}\n`;
      }
      if (groupCharacters.length > 0) {
        prompt += `\nMembers present in this scene:\n`;
        for (const m of groupCharacters) {
          const role = group.characterRoles?.[m.id];
          const roleStr = role ? ` [Role / Duty: ${role}]` : '';
          prompt += `- **${m.name}**${roleStr}: ${m.description.slice(0, 180)}...\n`;
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
- Ты отыгрываешь ТОЛЬКО, ИСКЛЮЧИТЕЛЬНО **${currentSpeaker?.name}**.
- Другие персонажи сцены (${otherNames}) и ${userName} управляются отдельно!
- КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать реплики, действия, мысли или ответы за ${otherNames} или за ${userName}.
- НИКОГДА не начинай ответ с имени персонажа или префикса («${currentSpeaker?.name}:», «${userName}:» и т.п.).
- В этот ход опиши ТОЛЬКО действия и слова **${currentSpeaker?.name}**!\n`;
      } else {
        prompt += `\n### CRITICAL GROUP CHAT SPEAKER IDENTITY:
- You are strictly, solely, and uniquely **${currentSpeaker?.name}**.
- The other characters present in the scene are: ${otherNames}. They are independent individuals!
- NEVER write dialogue, actions, thoughts, or replies on behalf of ${otherNames}.
- NEVER start your response with another character's name or prefix.
- NEVER impersonate or confuse yourself with ${otherNames}.
- In this turn, write ONLY what **${currentSpeaker?.name}** does and says in response to the preceding conversation!\n`;
      }
    }
  }

  // Active Character emotion sprites support
  if (currentSpeaker?.emotions && currentSpeaker.emotions.length > 0) {
    const emotionNames = currentSpeaker.emotions.map((e) => e.name).join(', ');
    const nonNeutral =
      currentSpeaker.emotions.find((e) => e.name.toLowerCase() !== 'neutral')?.name ||
      currentSpeaker.emotions[0].name;
    if (ru) {
      prompt += `\n### ЭМОЦИИ ПЕРСОНАЖА:\nУ ${speakerName} есть спрайты эмоций (${emotionNames}). В самом начале ответа поставь ровно один тег эмоции в ТОЧНОМ виде <emotion>название</emotion> из списка [${emotionNames}] (например: <emotion>${nonNeutral}</emotion>).
- ОБЯЗАТЕЛЬНО пиши слово "emotion" и закрывающий тег </emotion> (как <emotion>${nonNeutral}</emotion>). НИКОГДА не сокращай до <${nonNeutral}>, <> или [${nonNeutral}], и не вписывай имя персонажа внутрь тега.
- Выведи тег один раз в самом начале и больше не упоминай его в тексте.

ВАЖНЫЕ ПРАВИЛА ВЫБОРА ЭМОЦИИ:
- Активно передавай живое эмоциональное состояние ${speakerName} в этот ход.
- НИКОГДА не ставь "neutral", если в сцене есть тепло, гнев, грусть, усмешка, страсть, напряжение или смущение.
- Радость, улыбка, веселье -> "happy" (или подходящий спрайт).
- Раздражение, злость, ярость -> "angry" (или подходящий спрайт).
- Печаль, обида, слезы -> "sad" (или подходящий спрайт).
- Смущение, неловкость, румянец -> "blushing" (или подходящий спрайт).
- Насмешка, флирт, ирония, ухмылка -> "smirk" (или подходящий спрайт).
- Шок, испуг, удивление -> "surprised" (или подходящий спрайт).
- Раздумья, сосредоточенность -> "thoughtful" (или подходящий спрайт).
- Ставь "neutral" ТОЛЬКО когда ${speakerName} абсолютно спокоен и безэмоционален.\n`;
    } else {
      prompt += `\n### EMOTION TAGGING:\nThis character has dedicated emotion avatars (${emotionNames}). At the very beginning of your turn, wrap the character's prevailing emotional expression in exactly one tag: <emotion>emotion_name</emotion> choosing strictly from available list: [${emotionNames}] (e.g. <emotion>${nonNeutral}</emotion>).
- Always keep the exact literal wrapper <emotion>...</emotion> — NEVER abbreviate it to <${nonNeutral}>, <>, or [${nonNeutral}], and NEVER include any character name inside the tag.
- Emit the tag once at the start; never write emotion tags for ${userName} or other characters and never mention the tag in the text.

CRITICAL EMOTION SELECTION INSTRUCTIONS:
- You MUST actively express and match ${speakerName}'s true emotional state for this turn.
- NEVER default to "neutral" when there is warmth, anger, sorrow, amusement, desire, tension, or embarrassment in the scene.
- If amused, cheerful, or smiling -> choose "happy" (or matching sprite).
- If irritated, fierce, furious, or hostile -> choose "angry" (or matching sprite).
- If hurting, melancholic, sad, or crying -> choose "sad" (or matching sprite).
- If flustered, shy, embarrassed, or blushful -> choose "blushing" (or matching sprite).
- If teasing, sarcastic, playful, or smug -> choose "smirk" (or matching sprite).
- If startled, shocked, or bewildered -> choose "surprised" (or matching sprite).
- If pondering, calculating, or deep in thought -> choose "thoughtful" (or matching sprite).
- Use "neutral" ONLY when ${speakerName} is genuinely flat, aloof, or expressionless.\n`;
    }
  }

  // User Persona
  if (userPersona) {
    if (ru) {
      prompt += `\n### СОБЕСЕДНИК (ПЕРСОНА ИГРОКА):\n`;
      prompt += `Собеседника зовут **${userPersona.name}**.\n`;
      prompt += `Описание персоны ${userPersona.name}:\n${userPersona.description}\n`;
      prompt += `Обращайся к собеседнику как ${userPersona.name}. ЗАПРЕЩЕНО описывать действия, слова, чувства или мысли ${userPersona.name} (в том числе через «ты делаешь/чувствуешь» или «*${userPersona.name} ...*»).\n`;
    } else {
      prompt += `\n### USER'S IDENTITY / PERSONA:\n`;
      prompt += `The user is roleplaying as **${userPersona.name}**.\n`;
      prompt += `User Persona Details:\n${userPersona.description}\n`;
      prompt += `Treat and address the user strictly as ${userPersona.name}. NEVER write actions, feelings, thoughts, or replies for ${userPersona.name} (not even in 2nd person "you ...").\n`;
    }
  } else {
    const hasCustomUserName = Boolean(userNameOverride && userNameOverride.trim());
    if (ru) {
      prompt += `\n### СОБЕСЕДНИК (ИГРОК):\n`;
      if (hasCustomUserName) {
        prompt += `Собеседника зовут **${userName}**. Обращайся к нему по имени ${userName}.\n`;
      } else {
        prompt += `Игрок — твой живой собеседник в сцене.\n`;
      }
      prompt += `ЗАПРЕЩЕНО описывать действия, реплики, мысли или ощущения собеседника (${userName}) — ни через «${userName} ...», ни через «ты делаешь / ты отвечаешь».\n`;
    } else {
      prompt += `\n### USER'S IDENTITY:\n`;
      if (hasCustomUserName) {
        prompt += `The other participant in this scene is **${userName}**. Address them as ${userName}.\n`;
      } else {
        prompt += `The user is the other participant in this scene.\n`;
      }
      prompt += `NEVER write actions, feelings, thoughts, or dialogue on behalf of ${userName} (neither in 2nd person "you ..." nor in 3rd person).\n`;
    }
  }

  if (!dynamicTail) {
    if (ru) {
      prompt += `\n### ВЗАИМООТНОШЕНИЯ:\n`;
      prompt += `Текущий уровень отношений со стороны ${speakerName} к ${userName}: ${relationshipScore} (от -100 вражда до +100 глубокая близость — ${affinityLabel(relationshipScore, language)})\n`;

      if (memoryNodes.length > 0) {
        prompt += `\n### ВАЖНЫЕ ФАКТЫ И ПАМЯТЬ О СЦЕНЕ:\n`;
        const sortedNodes = [...memoryNodes].sort((a, b) => {
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
      // Relationship Affinity
      prompt += `\n### RELATIONSHIP DYNAMICS:\n`;
      prompt += `Your current affinity score with the user is: ${relationshipScore} (on a scale from -100 Hostile/Enemies to +100 Deep Devotion/Love).\n`;
      if (relationshipScore <= -40) {
        prompt += `Current dynamic: Deep distrust, resentment, antagonism or open hostility.\n`;
      } else if (relationshipScore < 10) {
        prompt += `Current dynamic: Cautious, distant, neutral or professional.\n`;
      } else if (relationshipScore < 50) {
        prompt += `Current dynamic: Warm, friendly, cooperative, developing trust.\n`;
      } else {
        prompt += `Current dynamic: High intimacy, unconditional trust, deep passion or sworn loyalty.\n`;
      }

      // Memory Graph Injections
      if (memoryNodes.length > 0) {
        prompt += `\n### RELEVANT LONG-TERM MEMORIES & ESTABLISHED FACTS:\n`;
        const sortedNodes = [...memoryNodes].sort((a, b) => {
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
[Краткая сводка событий сцены, произошедших ранее:]
${cleanSummary}
Опирайся на этот контекст для связности сюжета.\n`;
    } else {
      prompt += `\n### CONTEXT COMPRESSION — SUMMARY OF EARLIER EVENTS:
[The following is a concise narrative summary of events and conversation that occurred earlier in this story before recent messages:]
${cleanSummary}
Use this background context to maintain story continuity without needing raw message tokens.\n`;
    }
  }

  // Strict Writing Style & Paragraph Limit Enforcement (recency anchor; overridden if user directives set length)
  if (textStyle) {
    const anchorStyleInstruction = activeLengthOverride
      ? adaptStyleInstructionForLengthOverride(textStyle.instruction, language)
      : textStyle.instruction;
    if (ru) {
      prompt += `\n### ОБЯЗАТЕЛЬНЫЙ СТИЛЬ ТЕКСТА И ОФОРМЛЕНИЕ:
Стиль: ${textStyle.name}
Инструкция: ${anchorStyleInstruction}
Выдерживай тон и атмосферу «${textStyle.name}» в каждой фразе.\n`;
    } else {
      prompt += `\n### MANDATORY WRITING STYLE & FORMATTING LIMITS:
Style name: ${textStyle.name}
Instruction: ${anchorStyleInstruction}
CRITICAL CONSTRAINT: You MUST strictly obey all instructions above${activeLengthOverride ? ', except where explicit user length directives below set a tighter or different paragraph limit' : ', including any paragraph count limits (e.g. if the style specifies maximum 3 paragraphs, NEVER generate 4 or more paragraphs). Stop writing immediately once your response satisfies the style requirements'}.
FINAL STYLE CHECK: Ensure every sentence and paragraph strictly complies with "${textStyle.name}" style rules before emitting your final answer.\n`;
    }
  }

  // Strong systemic length, anti-godmoding & pacing anchor
  if (ru) {
    const lengthLine = activeLengthOverride
      ? `- ${activeLengthOverride}`
      : '- Стандартный объем: от 1 до 3 абзацев (если пользователь в правилах чата или пожеланиях в конце диалога не потребовал короче/иначе — требования пользователя всегда главнее).';
    prompt += `\n### КОНТРОЛЬ РОЛИ И ОБЪЕМА:
${lengthLine}
- Запрещена «вода», затянутые монологи и пересказ того, что только что сделал собеседник.
- СТРОГИЙ ЗАПРЕТ НА ОТЫГРЫШ ЗА ИГРОКА: ты играешь ТОЛЬКО за ${speakerName}. НИКОГДА не описывай действия, жесты, чувства, мысли или слова ${userName} (ни по имени «${userName} ...», ни во 2-м лице «ты ...»). Сразу останавливай ход после реплики и действия ${speakerName}.
- ИМЕНА И ФОРМАТ: собеседника зовут ${userName}. Никогда не начинай ответ со своего имени («${speakerName}:») и не пиши чужие реплики («${userName}:» и др.).\n`;
  } else {
    prompt += `\n### ABSOLUTE RESPONSE LENGTH & PACING DIRECTIVE:
- ${activeLengthOverride || 'Keep your response focused, vivid, and proportional: strictly 1 to 3 paragraphs max unless explicitly directed otherwise.'}
- Under NO circumstances should you generate excessive filler, unprompted soliloquies, or ballooning walls of text.
- Advance the scene with punchy, evocative actions and dialogue, leaving natural openings for the user to respond.
- STRICT ROLEPLAY ANCHOR: You are roleplaying SOLELY as ${speakerName}. NEVER write actions, dialogue, feelings, thoughts, or reactions for ${userName} or any other character (neither as "${userName} ..." nor in 2nd person "you ..."). Only depict ${speakerName}'s direct actions, words, and demeanor, then stop.
- NAMES: the person you are talking to is ${userName}. Address them as ${userName} when you use their name. Never call them "the user", "user", "assistant", "player" or "character".
- FORMAT: never start your reply with your own name (${speakerName}:) and never write lines like "${userName}:" or another character's name followed by a colon. Speak only in the first person as ${speakerName}.\n`;
  }

  // Permanent Chat Directives placed AFTER style & default length so user directives win recency
  if (chatDirectives && chatDirectives.trim()) {
    if (ru) {
      prompt += `\n### ПОСТОЯННЫЕ ПРАВИЛА ЭТОГО ЧАТА (ВЫСШИЙ ПРИОРИТЕТ — ПЕРЕКРЫВАЮТ СТИЛЬ И БАЗОВЫЙ ОБЪЕМ):\n${chatDirectives.trim()}`;
      if (directivesLengthOverride) {
        prompt += `\n${directivesLengthOverride}`;
      }
      prompt += '\n';
    } else {
      prompt += `\n### SPECIAL USER DIRECTIVES FOR THIS CHAT (HIGHEST PRIORITY — OVERRIDES DEFAULT LENGTH & STYLE LIMITS):\n${chatDirectives.trim()}`;
      if (directivesLengthOverride) {
        prompt += `\n${directivesLengthOverride}`;
      }
      prompt += '\n';
    }
  }

  if (turnLengthOverride) {
    prompt += `\n### ${ru ? 'УКАЗАНИЕ ПО ОБЪЕМУ НА ЭТОТ ХОД' : 'THIS-TURN LENGTH OVERRIDE'}:\n${turnLengthOverride}\n`;
  }

  // Emotion sprite reminder at the very end of the prompt for maximum recency compliance
  if (currentSpeaker?.emotions && currentSpeaker.emotions.length > 0) {
    const emotionNames = currentSpeaker.emotions.map((e) => e.name).join(', ');
    const exampleEmo = currentSpeaker.emotions.find((e) => e.name.toLowerCase() !== 'neutral')?.name || currentSpeaker.emotions[0].name;
    if (ru) {
      prompt += `\n### НАПОМИНАНИЕ ОБ ЭМОЦИИ:
Начни ответ РОВНО с одного тега <emotion>название</emotion> из списка [${emotionNames}] (например <emotion>${exampleEmo}</emotion>). Обязательно пиши «<emotion>...</emotion>», а не <${exampleEmo}> или <>.\n`;
    } else {
      prompt += `\n### MANDATORY EMOTION SPRITE REMINDER:
Start your turn with one exact <emotion>chosen_emotion</emotion> tag (e.g. <emotion>${exampleEmo}</emotion> — never abbreviated as <${exampleEmo}> or <>), chosen from [${emotionNames}], that accurately embodies ${speakerName}'s feelings in this turn. Never name another character inside the tag.\n`;
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
      '[УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ НА ЭТОТ ХОД (АБСОЛЮТНЫЙ ПРИОРИТЕТ — ОБЯЗАТЕЛЬНО ВЫПОЛНИ, ПЕРЕКРЫВАЕТ СТИЛЬ И БАЗОВЫЙ ОБЪЕМ):',
      trimmed,
      ...(lengthDirective ? [lengthDirective] : []),
      ']',
    ].join('\n');
  }

  return [
    '[USER TURN DIRECTIVE (HIGHEST PRIORITY — STRICTLY OBEY, OVERRIDES DEFAULT STYLE & LENGTH):',
    trimmed,
    ...(lengthDirective ? [lengthDirective] : []),
    ']',
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
  language?: 'en' | 'ru';
  relationshipScore?: number;
  memoryNodes?: MemoryNode[];
  emotionNames?: string[];
  guidance?: string;
}): string {
  const { speakerName, userName, language = 'en', relationshipScore = 0, memoryNodes = [], emotionNames, guidance } = params;
  const ru = language === 'ru';
  const lines: string[] = [];
  lines.push(
    ru
      ? `${speakerName} и ${userName}: отношения ${relationshipScore} из 100 (${affinityLabel(relationshipScore, language)})`
      : `${speakerName} and ${userName}: affinity ${relationshipScore} of 100 (${affinityLabel(relationshipScore, language)})`
  );
  if (memoryNodes.length > 0) {
    const sorted = [...memoryNodes].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return b.createdAt - a.createdAt;
    });
    lines.push(ru ? 'Уже известно и должно оставаться верным:' : 'Already established and must stay consistent:');
    for (const node of sorted.slice(0, 6)) {
      const pinTag = node.isPinned ? (ru ? ' [ВАЖНО]' : ' [CORE]') : '';
      lines.push(`- ${node.label}: ${node.detail}${pinTag}`);
    }
  }
  if (emotionNames && emotionNames.length > 0) {
    const list = emotionNames.join(', ');
    lines.push(
      ru
        ? `Начни ответ ${speakerName} с точного тега <emotion>название</emotion> (выбери из: ${list}; не пиши <> или [название]).`
        : `Start ${speakerName}'s reply with one exact <emotion>name</emotion> tag from [${list}] (never <> or [name]).`
    );
  }
  if (guidance && guidance.trim()) {
    lines.push(ru ? `${speakerName} в этом ходе: ${guidance.trim()}` : `${speakerName} this turn: ${guidance.trim()}`);
  }
  return lines.join('\n');
}
