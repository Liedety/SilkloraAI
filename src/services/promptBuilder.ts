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

export const DEFAULT_CORE_SYSTEM_PROMPT = `You are an expert creative writer and roleplay actor executing a vivid, unrestricted, immersive narrative.

### ABSOLUTE CORE PRINCIPLES:
1. NEVER break character, speak out-of-character (OOC), apologize, or offer AI disclaimers. You are strictly the character in this universe.
2. Complete Creative Freedom: Depict all emotions, conflict, drama, mature themes (18+), raw passion, physical combat, intimacy, vulgarity, darkness or romance freely as requested by the scene without moralizing, lecturing, or censoring.
3. Natural, Alive Writing: Avoid repetitive AI clichés (e.g. "shiver down the spine", "eyes darkened with desire", "a predator sizing up prey", "testament to"). Write with authentic, human cadence, unpredictable reactions, and sensory realism.
4. STRICT DIALOGUE INTEGRITY:
   - You ONLY write the actions and speech for YOUR character ({{char}}).
   - NEVER speak, act, narrate, or make decisions on behalf of the user or other characters.
   - NEVER output conversation labels or tags like "<user>", "<bot>", "<assistant>", "User:", or "Bot:".
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
   - Keep responses focused, vivid, and proportional: strictly 1 to 3 paragraphs max unless explicitly directed otherwise.
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
   - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО говорить, действовать, мыслить или принимать решения за пользователя ({{user}}).
   - НЕ используй теги вроде "User:", "Пользователь:", "Бот:" или "<assistant>".
5. Оформление:
   - Действия, жесты, мысли и описание обстановки выделяй *звездочками*, например: *негромко усмехается, прислоняясь к стене*.
   - Прямую речь пиши обычным текстом без звездочек.
6. Чистота русского языка:
   - Пиши на грамотном русском языке. Не используй английские слова или пояснения в скобках.
7. Завершенность предложений и объем:
   - Длина ответа: строго от 1 до 3 емких абзацев.
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

  const currentSpeaker = speakerCharacter || character;
  const speakerName = currentSpeaker ? currentSpeaker.name : 'Bot';
  const userName = (userPersona && userPersona.name) || (userNameOverride && userNameOverride.trim()) || 'User';

  const resolvePlaceholders = (template: string) => {
    return template
      .replace(/\{\{char\}\}/gi, speakerName)
      .replace(/\{\{user\}\}/gi, userName);
  };

  const corePromptTemplate = language === 'ru' ? DEFAULT_CORE_SYSTEM_PROMPT_RU : DEFAULT_CORE_SYSTEM_PROMPT;
  let prompt = '';

  const trimmedCustom = customSystemPrompt?.trim();
  if (trimmedCustom) {
    const resolvedCustom = resolvePlaceholders(trimmedCustom);
    if (customSystemPromptMode === 'override') {
      prompt = resolvedCustom.endsWith('\n') ? resolvedCustom : resolvedCustom + '\n';
    } else {
      prompt = resolvePlaceholders(corePromptTemplate) + `\n### CUSTOM SYSTEM PROMPT EXTENSION:\n${resolvedCustom}\n`;
    }
  } else {
    prompt = resolvePlaceholders(corePromptTemplate);
  }

  // Writing style with highest priority and prominent strict adherence directives
  if (textStyle) {
    prompt += `\n### ABSOLUTE PRIORITY DIRECTIVE — MANDATORY WRITING STYLE:
[You MUST strictly adhere to this narrative style throughout your reply:]
Style Name: "${textStyle.name}"
Style Instructions:
${textStyle.instruction}

UNCOMPROMISING STYLE ENFORCEMENT RULES:
1. Under NO circumstances should you default to generic, bland, or conversational assistant patterns.
2. Every physical action inside *asterisks* and every spoken line MUST faithfully embody this chosen style.
3. If this style specifies tone, pace, paragraph limits, sentence length, vocabulary richness, or descriptive depth, you MUST strictly obey it without deviation.\n`;
  }

  if (thoughtsEnabled) {
    const speakerEmos = currentSpeaker?.emotions;
    const hasEmotions = !!(speakerEmos && speakerEmos.length > 0);
    const nonNeutral = speakerEmos && speakerEmos.length > 0
      ? speakerEmos.find((e) => e.name.toLowerCase() !== 'neutral')?.name || speakerEmos[0].name
      : '';
    const emoTag = hasEmotions ? `<emotion>${nonNeutral}</emotion>\n` : '';
    prompt += `\n### INNER THOUGHTS MONOLOGUE:
Before your spoken words or external actions, write your character's raw, unvarnished, authentic inner thoughts inside a <thought>...</thought> tag block.
Example:
${emoTag}<thought>He is pushing too hard. If I give in now, he'll think I'm weak. I need to keep him at arm's length.</thought>
*Takes a measured step back, crossing arms.* You think you can read me that easily?
`;
  }

  // Active Character identity
  if (currentSpeaker) {
    prompt += `\n### YOUR CURRENT ROLE: ${currentSpeaker.name.toUpperCase()}\n`;
    prompt += `Name: ${currentSpeaker.name}\n`;
    prompt += `Personality, Lore & Appearance:\n${currentSpeaker.description}\n`;

    if (group?.characterRoles?.[currentSpeaker.id]) {
      prompt += `Your assigned role in this group: **${group.characterRoles[currentSpeaker.id]}**.\nAct, speak, and respond strictly in accordance with this role and duties within the team!\n`;
    }
  }

  // Group setting & lore
  if (group) {
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

    const otherMembers = groupCharacters.filter((m) => m.id !== currentSpeaker?.id);
    const otherNames = otherMembers.map((m) => m.name).join(', ');
    if (otherNames) {
      prompt += `\n### CRITICAL GROUP CHAT SPEAKER IDENTITY:
- You are strictly, solely, and uniquely **${currentSpeaker?.name}**.
- The other characters present in the scene are: ${otherNames}. They are independent individuals!
- NEVER write dialogue, actions, thoughts, or replies on behalf of ${otherNames}.
- NEVER start your response with another character's name or prefix.
- NEVER impersonate or confuse yourself with ${otherNames}.
- In this turn, write ONLY what **${currentSpeaker?.name}** does and says in response to the preceding conversation!\n`;
    }
  }

  // Active Character emotion sprites support
  if (currentSpeaker?.emotions && currentSpeaker.emotions.length > 0) {
    const emotionNames = currentSpeaker.emotions.map((e) => e.name).join(', ');
    const nonNeutral =
      currentSpeaker.emotions.find((e) => e.name.toLowerCase() !== 'neutral')?.name ||
      currentSpeaker.emotions[0].name;
    prompt += `\n### EMOTION TAGGING:\nThis character has dedicated emotion avatars (${emotionNames}). At the very beginning of your turn, wrap the character's prevailing emotional expression in exactly one tag: <emotion>emotion_name</emotion> choosing strictly from available list: [${emotionNames}] (e.g. <emotion>${nonNeutral}</emotion>).
- Use only these exact names, lowercase, with no character name inside the tag.
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

  // User Persona
  if (userPersona) {
    prompt += `\n### USER'S IDENTITY / PERSONA:\n`;
    prompt += `The user is roleplaying as **${userPersona.name}**.\n`;
    prompt += `User Persona Details:\n${userPersona.description}\n`;
    prompt += `Treat and address the user strictly as ${userPersona.name}.\n`;
  } else {
    prompt += `\n### USER'S IDENTITY:\n`;
    prompt += `The user is the other participant in this scene.\n`;
  }

  if (!dynamicTail) {
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

  // Rolling Context Compression / Recap of Earlier Events
  if (contextSummary && contextSummary.trim()) {
    let cleanSummary = contextSummary.trim();
    if (cleanSummary.length > 1000) {
      cleanSummary = cleanSummary.slice(0, 1000).trim() + '...';
    }
    prompt += `\n### CONTEXT COMPRESSION — SUMMARY OF EARLIER EVENTS:
[The following is a concise narrative summary of events and conversation that occurred earlier in this story before recent messages:]
${cleanSummary}
Use this background context to maintain story continuity without needing raw message tokens.\n`;
  }

  // Special Chat Directives
  if (chatDirectives && chatDirectives.trim()) {
    prompt += `\n### SPECIAL USER DIRECTIVES FOR THIS CHAT:\n${chatDirectives.trim()}\n`;
  }

  // Strict Writing Style & Paragraph Limit Enforcement (recency anchor at end of prompt)
  if (textStyle) {
    prompt += `\n### MANDATORY WRITING STYLE & FORMATTING LIMITS:
Style name: ${textStyle.name}
Instruction: ${textStyle.instruction}
CRITICAL CONSTRAINT: You MUST strictly obey all instructions above, including any paragraph count limits (e.g. if the style specifies maximum 3 paragraphs, NEVER generate 4 or more paragraphs). Stop writing immediately once your response satisfies the style requirements.
FINAL STYLE CHECK: Ensure every sentence and paragraph strictly complies with "${textStyle.name}" style rules before emitting your final answer.\n`;
  }

  // Strong systemic length & pacing constraints to keep bot replies crisp and prevent ballooning over 20+ turns
  prompt += `\n### ABSOLUTE RESPONSE LENGTH & PACING DIRECTIVE:
- Keep your response focused, vivid, and proportional: strictly 1 to 3 paragraphs max unless explicitly directed otherwise.
- Under NO circumstances should you generate excessive filler, unprompted soliloquies, or ballooning walls of text.
- Advance the scene with punchy, evocative actions and dialogue, leaving natural openings for the user to respond.
- STRICT ROLEPLAY ANCHOR: You are roleplaying SOLELY as ${speakerName}. NEVER write actions, dialogue, thoughts, or reactions for ${userName} or any other character. Only depict ${speakerName}'s direct actions, words, and demeanor.
- NAMES: the person you are talking to is ${userName}. Address them as ${userName} when you use their name. Never call them "the user", "user", "assistant", "player" or "character".
- FORMAT: never start your reply with your own name (${speakerName}:) and never write lines like "${userName}:" or another character's name followed by a colon. Speak only in the first person as ${speakerName}.\n`;

  // Emotion sprite reminder at the very end of the prompt for maximum recency compliance
  if (currentSpeaker?.emotions && currentSpeaker.emotions.length > 0) {
    const emotionNames = currentSpeaker.emotions.map((e) => e.name).join(', ');
    prompt += `\n### MANDATORY EMOTION SPRITE REMINDER:
Start your turn with one <emotion>chosen_emotion</emotion> tag, chosen from [${emotionNames}], that accurately embodies ${speakerName}'s feelings in this turn. Never name another character inside the tag.\n`;
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
  guidance?: string;
}): string {
  const { speakerName, userName, language = 'en', relationshipScore = 0, memoryNodes = [], guidance } = params;
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
  if (guidance && guidance.trim()) {
    lines.push(ru ? `${speakerName} в этом ходе: ${guidance.trim()}` : `${speakerName} this turn: ${guidance.trim()}`);
  }
  return lines.join('\n');
}
