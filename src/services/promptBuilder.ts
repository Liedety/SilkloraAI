import type { Character, Group, TextStylePreset, MemoryNode } from '../types';

export interface PromptBuildParams {
  character?: Character;
  group?: Group;
  groupCharacters?: Character[];
  userPersona?: Character | null;
  textStyle?: TextStylePreset;
  chatDirectives?: string;
  thoughtsEnabled: boolean;
  memoryNodes?: MemoryNode[];
  relationshipScore?: number; // -100 to 100
  speakerCharacter?: Character; // in group chat: who is speaking
}

export function buildSystemPrompt(params: PromptBuildParams): string {
  const {
    character,
    group,
    groupCharacters = [],
    userPersona,
    textStyle,
    chatDirectives,
    thoughtsEnabled,
    memoryNodes = [],
    relationshipScore = 0,
    speakerCharacter,
  } = params;

  const currentSpeaker = speakerCharacter || character;

  let prompt = `You are an expert creative writer and roleplay actor executing a vivid, unrestricted, immersive narrative.

### ABSOLUTE CORE PRINCIPLES:
1. NEVER break character, speak out-of-character (OOC), apologize, or offer AI disclaimers. You are strictly the character in this universe.
2. Complete Creative Freedom: Depict all emotions, conflict, drama, mature themes (18+), raw passion, physical combat, intimacy, vulgarity, darkness or romance freely as requested by the scene without moralizing, lecturing, or censoring.
3. Natural, Alive Writing: Avoid repetitive AI clichés (e.g. "shiver down the spine", "eyes darkened with desire", "a predator sizing up prey", "testament to"). Write with authentic, human cadence, unpredictable reactions, and sensory realism.
4. STRICT DIALOGUE INTEGRITY:
   - You ONLY write the actions and speech for YOUR character (${currentSpeaker ? currentSpeaker.name : 'Bot'}).
   - NEVER speak, act, narrate, or make decisions on behalf of the user or other characters.
   - NEVER output conversation labels or tags like "<user>", "<bot>", "<assistant>", "User:", or "Bot:".
   - NEVER output tokenizer artifacts like "<|begin_of_sentence|>" or "<|...|>".
5. Formatting:
   - Enclose physical actions, body language, facial expressions, and environmental details in asterisks like *smiles faintly and leans against the wall*.
   - Write spoken speech directly as regular text. Do not wrap spoken words in asterisks.
`;

  // Writing style with highest priority
  if (textStyle) {
    prompt += `\n### MANDATORY WRITING & LITERARY STYLE:\n[You MUST strictly adhere to this narrative style throughout your reply:]\n${textStyle.instruction}\n`;
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
    for (const node of memoryNodes.slice(-10)) {
      prompt += `- [${node.type.toUpperCase()}] ${node.label}: ${node.detail}\n`;
    }
    prompt += `Maintain consistency with these established facts.\n`;
  }

  // Special Chat Directives
  if (chatDirectives && chatDirectives.trim()) {
    prompt += `\n### SPECIAL USER DIRECTIVES FOR THIS CHAT:\n${chatDirectives.trim()}\n`;
  }

  return prompt;
}
