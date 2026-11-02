import type { Character, Group, TextStylePreset, MemoryNode } from '../types';

export interface PromptBuildParams {
  character?: Character;
  group?: Group;
  groupCharacters?: Character[];
  userPersona?: Character | null;
  textStyle?: TextStylePreset;
  chatDirectives?: string;
  thoughtsEnabled?: boolean;
  memoryNodes?: MemoryNode[];
  relationshipScore?: number; // -100 to 100
  speakerCharacter?: Character; // in group chat: who is speaking
  customSystemPrompt?: string;
  customSystemPromptMode?: 'override' | 'augment';
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
6. STRICT LANGUAGE PURITY & MONOLINGUAL CONSISTENCY:
   - You MUST reply 100% strictly in the language of the conversation. When user or characters communicate in Russian, generate pure, high-quality literary Russian.
   - NEVER switch to English mid-sentence or mid-dialogue.
   - NEVER insert English words, translations, or parenthetical annotations (e.g. NEVER write words like "relief (облегчение)", "anger", "feeling" inside Russian prose).
   - Maintain seamless narrative immersion without code-switching.
`;

export function buildSystemPrompt(params: PromptBuildParams): string {
  const {
    character,
    group,
    groupCharacters = [],
    userPersona,
    textStyle,
    chatDirectives,
    thoughtsEnabled = false,
    memoryNodes = [],
    relationshipScore = 0,
    speakerCharacter,
    customSystemPrompt,
    customSystemPromptMode = 'augment',
  } = params;

  const currentSpeaker = speakerCharacter || character;
  const speakerName = currentSpeaker ? currentSpeaker.name : 'Bot';
  const userName = userPersona ? userPersona.name : 'User';

  const resolvePlaceholders = (template: string) => {
    return template
      .replace(/\{\{char\}\}/gi, speakerName)
      .replace(/\{\{user\}\}/gi, userName);
  };

  let prompt = '';

  const trimmedCustom = customSystemPrompt?.trim();
  if (trimmedCustom) {
    const resolvedCustom = resolvePlaceholders(trimmedCustom);
    if (customSystemPromptMode === 'override') {
      prompt = resolvedCustom.endsWith('\n') ? resolvedCustom : resolvedCustom + '\n';
    } else {
      prompt = resolvePlaceholders(DEFAULT_CORE_SYSTEM_PROMPT) + `\n### CUSTOM SYSTEM PROMPT EXTENSION:\n${resolvedCustom}\n`;
    }
  } else {
    prompt = resolvePlaceholders(DEFAULT_CORE_SYSTEM_PROMPT);
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
    prompt += `\n### INNER THOUGHTS MONOLOGUE:
Before your spoken words or external actions, write your character's raw, unvarnished, authentic inner thoughts inside a <thought>...</thought> tag block.
Example:
<thought>He is pushing too hard. If I give in now, he'll think I'm weak. I need to keep him at arm's length.</thought>
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
    prompt += `\n### EMOTION TAGGING:\nThis character has dedicated emotion avatars (${emotionNames}). At the very beginning of your turn, wrap the character's prevailing emotional expression in tag: <emotion>emotion_name</emotion> choosing strictly from available list: [${emotionNames}] (e.g. <emotion>${currentSpeaker.emotions[0].name}</emotion>).\n`;
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
    for (const node of sortedNodes.slice(0, 10)) {
      const pinTag = node.isPinned ? ' [CORE/PERMANENT]' : '';
      prompt += `- [${node.type.toUpperCase()}${pinTag}] ${node.label}: ${node.detail}\n`;
    }
    prompt += `Maintain consistency with these established facts.\n`;
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

  return prompt;
}
