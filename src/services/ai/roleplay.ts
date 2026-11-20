import type { ApiKeyConfig, Character, Group, Language } from '../../types';
import { RP_SAMPLER_PRESETS } from './config.ts';
import { streamChatCompletion, type ChatCompletionMessage } from './streaming.ts';
import {
  cleanArtifacts,
  escapeRegex,
  normalizeNativeThoughtTags,
  speakerStopStrings,
  stripEmotionTags,
  stripLeadingSpeakerName,
} from './textProcessing.ts';

export async function generatePersonaWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  concept: string,
  dos: string,
  donts: string,
  photoRef?: string,
  contextLore?: string,
  language: Language = 'en'
): Promise<{ name: string; description: string; greeting: string; scenario?: string; exampleDialogue?: string }> {
  const isRu = language === 'ru';
  const languageInstruction = isRu
    ? `ВАЖНО: Язык генерации — РУССКИЙ. Все поля ("name", "description", "scenario", "exampleDialogue", "greeting") ОБЯЗАТЕЛЬНО должны быть написаны на чистом, выразительном русском языке. Никаких английских слов.`
    : `Language: English.`;

  const systemPrompt = `You are an elite creative director for deep, unrestricted roleplay characters.
Given a concept and preferences, generate an extraordinarily detailed, distinct, and compelling roleplay persona.
${languageInstruction}

Return STRICT JSON only matching this exact format:
{
  "name": "Character Name",
  "description": "Exhaustive description covering: personality traits, dark secrets, speech patterns, appearance, background lore, vulnerabilities, habits.",
  "scenario": "Starting situation, current location, atmosphere, and relationship premise between {{char}} and {{user}}.",
  "exampleDialogue": "<START>\\n{{user}}: Sample prompt\\n{{char}}: *Concise physical action.* Characteristic reply capturing tone and speech style.",
  "greeting": "An atmospheric opening message establishing the first scene, with actions enclosed in *asterisks* and spoken dialogue in plain text."
}
CRITICAL RULES:
1. Output complete, fully articulated text. Do NOT cut off sentences.
2. Never leave placeholders or empty brackets like {}.
3. Do NOT wrap the JSON in markdown code blocks. Output raw JSON only.`;

  let userContent: any = `Concept / Idea: ${concept}\n`;
  if (contextLore) {
    userContent += `Related Universe / Companions Lore:\n${contextLore}\n`;
  }
  if (dos) {
    userContent += `What to include (DO): ${dos}\n`;
  }
  if (donts) {
    userContent += `What to avoid (DON'T): ${donts}\n`;
  }

  const messages: ChatCompletionMessage[] = [{ role: 'system', content: systemPrompt }];

  if (photoRef) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userContent + '\nAnalyze this reference photo and incorporate accurate physical appearance details into the character description.' },
        { type: 'image_url', image_url: { url: photoRef } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  let result = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages,
    temperature: 0.9,
    maxTokens: 4000,
    onToken: (tok) => { result += tok; },
    onError: (e) => { throw e; },
  });

  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.name && parsed.description) {
      return {
        name: String(parsed.name).trim(),
        description: cleanArtifacts(String(parsed.description)),
        greeting: cleanArtifacts(String(parsed.greeting || '')),
        scenario: parsed.scenario ? cleanArtifacts(String(parsed.scenario)) : undefined,
        exampleDialogue: parsed.exampleDialogue ? cleanArtifacts(String(parsed.exampleDialogue)) : undefined,
      };
    }
  } catch {
    // regex fallback below
  }

  const nameMatch = cleaned.match(/"name"\s*:\s*"([^"]+)"/);
  const greetingMatch = cleaned.match(/"greeting"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"|\s*})/);
  const descMatch = cleaned.match(/"description"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"greeting"|\s*})/);

  const fallbackName = nameMatch ? nameMatch[1] : (concept.slice(0, 30) || (isRu ? 'Безымянный персонаж' : 'Unknown Character'));
  const fallbackGreeting = greetingMatch
    ? cleanArtifacts(greetingMatch[1])
    : (isRu
        ? `*Смотрит на вас с внимательным интересом, слегка прищурившись.* Что привело тебя сюда?`
        : `*Stands before you, observing your presence with quiet curiosity.* What brings you here?`);
  let fallbackDesc = descMatch
    ? cleanArtifacts(descMatch[1])
    : cleanArtifacts(cleaned.replace(/^[{\s"name:]+/, '').replace(/[}\s]+$/, ''));

  if (!fallbackDesc || fallbackDesc.length < 5) {
    fallbackDesc = isRu ? `Загадочная личность, связанная с концептом: ${concept}` : `Mysterious entity tied to concept: ${concept}`;
  }

  return {
    name: fallbackName,
    description: fallbackDesc,
    greeting: fallbackGreeting,
  };
}

export async function generateGroupWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  concept: string,
  language: Language = 'en'
): Promise<{ name: string; description: string; backstory: string }> {
  const isRu = language === 'ru';
  const languageInstruction = isRu
    ? `ВАЖНО: Язык ответа — РУССКИЙ. Все поля ("name", "description", "backstory") должны быть написаны на русском языке.`
    : `Language: English.`;

  const systemPrompt = `You are a worldbuilding designer for collaborative roleplay universes.
Given an idea/theme, generate a rich faction/group setting.
${languageInstruction}

Return STRICT JSON only matching this exact format:
{
  "name": "Group / Faction / Universe Name",
  "description": "Atmospheric lore describing the world setting, faction rules, internal power dynamics, conflicts and secrets.",
  "backstory": "An engaging starting scene describing where the group gathers and the initial crisis or dialogue hook."
}
CRITICAL: Output complete valid JSON only with no markdown code blocks, no unclosed brackets, no trailing empty brackets {}.`;

  let result = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Group Theme / Idea: ${concept}` },
    ],
    temperature: 0.85,
    maxTokens: 3000,
    onToken: (tok) => { result += tok; },
    onError: (e) => { throw e; },
  });

  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return {
      name: String(parsed.name || (isRu ? 'Новая группа' : 'New Group')).trim(),
      description: cleanArtifacts(String(parsed.description || '')),
      backstory: cleanArtifacts(String(parsed.backstory || '')),
    };
  } catch {
    const nameM = cleaned.match(/"name"\s*:\s*"([^"]+)"/);
    const descM = cleaned.match(/"description"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"backstory"|\s*})/);
    const backM = cleaned.match(/"backstory"\s*:\s*"([\s\S]*?)"(?:\s*})/);

    return {
      name: nameM ? nameM[1] : (concept.slice(0, 30) || (isRu ? 'Группа' : 'Group')),
      description: descM ? cleanArtifacts(descM[1]) : cleanArtifacts(cleaned),
      backstory: backM ? cleanArtifacts(backM[1]) : (isRu ? 'Участники собираются в условленном месте...' : 'Members gather at the designated location...'),
    };
  }
}

export async function generateGroupRolesWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  groupName: string,
  groupDescription: string,
  characters: Character[],
  userConcept?: string,
  language: Language = 'en'
): Promise<Record<string, string>> {
  if (characters.length === 0) return {};
  const isRu = language === 'ru';

  const charProfiles = characters
    .map((c) => `- Character [${c.name}]: ${c.description.slice(0, 200)}`)
    .join('\n');

  const system = `You are a narrative director assigning distinctive roles and faction ranks to characters in a group.
${isRu ? 'Язык ответа: РУССКИЙ. Назначь каждому персонажу интересную и органичную роль в группе.' : 'Language: English. Assign fitting and distinct roles to each character in the group.'}

Respond STRICT JSON mapping character names to concise role titles with brief duties (1 short phrase or sentence):
{
  "Character Name": "Role / Rank (e.g. Master Hacker & Infiltrator)"
}
Raw JSON only.`;

  let user = `Group: ${groupName}\nLore: ${groupDescription}\n\nMembers:\n${charProfiles}`;
  if (userConcept && userConcept.trim()) {
    user += `\n\nUser instructions and desired assignments:\n${userConcept.trim()}`;
  }

  let result = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.8,
    maxTokens: 2000,
    onToken: (t) => { result += t; },
    onError: (e) => { throw e; },
  });

  const rolesMap: Record<string, string> = {};
  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    for (const c of characters) {
      if (parsed[c.name]) {
        rolesMap[c.id] = String(parsed[c.name]).trim();
      }
    }
  } catch {
    for (const c of characters) {
      const reg = new RegExp(`"${c.name}"\\s*:\\s*"([^"]+)"`, 'i');
      const m = cleaned.match(reg);
      if (m) {
        rolesMap[c.id] = m[1].trim();
      }
    }
  }

  for (const c of characters) {
    if (!rolesMap[c.id]) {
      rolesMap[c.id] = isRu ? 'Участник группы' : 'Group Member';
    }
  }

  return rolesMap;
}


export interface SuggestUserReplyOptions {
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
  userName?: string;
  otherSpeakers?: string[];
  language?: 'en' | 'ru';
}

function inferSpeakersFromHistory(recentHistory: string, excludeNames: string[]): string[] {
  const excluded = new Set(
    ['вы', 'you', 'игрок', 'player', 'user', 'assistant', 'bot', ...excludeNames]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const found: string[] = [];
  for (const line of recentHistory.split('\n')) {
    const m = line.match(/^\s*\[?([^:\[\]\n]{2,40})\]?\s*:\s*\S/);
    if (!m) continue;
    const candidate = m[1].trim();
    if (!excluded.has(candidate.toLowerCase()) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

export function buildGhostwriterMessages(params: {
  userPersona: Character | null;
  prompt: string;
  recentHistory: string;
  userName?: string;
  otherSpeakers?: string[];
  language?: 'en' | 'ru';
}): {
  system: string;
  userMsg: string;
  speakerLabel: string;
  otherSpeakers: string[];
} {
  const { userPersona, prompt, recentHistory, userName, otherSpeakers = [], language } = params;
  const isRu = language === 'ru' || (!language && /[а-яА-ЯёЁ]/.test(recentHistory + (userPersona?.description || '') + (prompt || '')));
  const speakerLabel =
    (userPersona?.name || userName || '').trim() ||
    (isRu ? 'Игрок' : 'Player');

  const uniqueOthers = Array.from(
    new Set([
      ...otherSpeakers.map((s) => (s || '').trim()).filter((s) => s && s.toLowerCase() !== speakerLabel.toLowerCase()),
      ...inferSpeakersFromHistory(recentHistory, [speakerLabel]),
    ])
  );

  // Align generic "Вы:" / "You:" prefixes in history with the active persona/speaker label
  const normalizedHistory = recentHistory.replace(
    /^(\s*)(Вы|You|Игрок|Player)(\s*:)/gm,
    `$1${speakerLabel}$3`
  );

  const effectivePrompt = prompt && prompt.trim()
    ? prompt.trim()
    : (isRu
        ? `Придумай естественную, логичную и живую реакцию от лица ${speakerLabel} в текущей ситуации.`
        : `Write a natural, vivid, in-character reply strictly on behalf of ${speakerLabel} in this scene.`);

  const othersText = uniqueOthers.join(', ');

  if (isRu) {
    const personaLine = userPersona
      ? `\nОписание персоны ${speakerLabel}: ${userPersona.description.slice(0, 320)}`
      : '';
    const othersLine = uniqueOthers.length > 0
      ? `\nДругие персонажи сцены (они управляются отдельно): ${othersText}.`
      : '';
    const forbiddenNames = uniqueOthers.length > 0
      ? ` («${speakerLabel}:», «Вы:», ${uniqueOthers.slice(0, 4).map((n) => `«${n}:»`).join(', ')})`
      : ` («${speakerLabel}:», «Вы:», «Игрок:»)`;

    const system = `Ты — помощник ролевой игры, формулирующий ТОЛЬКО одну следующую реплику игрока (${speakerLabel}).${personaLine}${othersLine}

СТРОГИЕ ПРАВИЛА:
1. Пиши ИСКЛЮЧИТЕЛЬНО от лица персонажа игрока (${speakerLabel}): действия и мимику в *звездочках*, прямую речь обычным текстом без кавычек-ёлочек и лишних пояснений.
2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать реплики, действия, реакции, чувства или мысли за ${othersText || 'других персонажей сцены'}. Остановись сразу после хода ${speakerLabel}.
3. НИКОГДА не начинай ответ с имени или двоеточия${forbiddenNames} и не добавляй никаких служебных или XML-тегов.
4. Выведи ТОЛЬКО саму реакцию ${speakerLabel}, готовый текст для отправки в чат (1–2 абзаца), без повторения предыдущих фраз.`;

    const userMsg = `Недавний диалог в сцене:\n${normalizedHistory}\n\nЗадача: напиши ТОЛЬКО следующий ход от лица «${speakerLabel}».${uniqueOthers.length > 0 ? ` Не описывай ходы и слова ${othersText}.` : ''}\nПожелание: ${effectivePrompt}\nНачни сразу с *действия* или фразы без имени в начале.`;

    return { system, userMsg, speakerLabel, otherSpeakers: uniqueOthers };
  }

  const personaLineEn = userPersona
    ? `\nUser persona details for ${speakerLabel}: ${userPersona.description.slice(0, 320)}`
    : '';
  const othersLineEn = uniqueOthers.length > 0
    ? `\nOther characters in this scene (controlled separately): ${othersText}.`
    : '';

  const system = `You are a creative roleplay ghostwriter composing ONLY the next single turn on behalf of the player (${speakerLabel}).${personaLineEn}${othersLineEn}

STRICT RULES:
1. Write STRICTLY from ${speakerLabel}'s perspective: physical actions inside *asterisks*, spoken dialogue as plain text without outer quotation marks.
2. NEVER write dialogue, actions, thoughts, or reactions on behalf of ${othersText || 'other characters'}. Stop immediately after ${speakerLabel}'s turn.
3. NEVER start the response with a character name or colon ("${speakerLabel}:", "You:"${uniqueOthers.length > 0 ? `, "${uniqueOthers[0]}:"` : ''}) and NEVER output any XML, emotion, or thought tags.
4. Output ONLY ${speakerLabel}'s ready-to-send message (1–2 concise paragraphs) without repeating earlier turns or adding meta notes.`;

  const userMsg = `Recent Scene History:\n${normalizedHistory}\n\nTask: Write ONLY ${speakerLabel}'s next turn.${uniqueOthers.length > 0 ? ` Do NOT narrate or speak for ${othersText}.` : ''}\nUser's Intent: ${effectivePrompt}\nBegin directly with *action* or dialogue with no leading name prefix.`;

  return { system, userMsg, speakerLabel, otherSpeakers: uniqueOthers };
}

export function cleanGhostwriterOutput(
  raw: string,
  speakerLabel: string,
  otherSpeakers: string[] = []
): string {
  if (!raw) return '';
  let out = normalizeNativeThoughtTags(raw)
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/^\s*<thought>[\s\S]*$/i, '');

  out = stripEmotionTags(out, undefined, { stripLeadingUnknownAngleTag: true });

  const allNames = Array.from(
    new Set([speakerLabel, ...otherSpeakers, 'Вы', 'Игрок', 'You', 'Player'].filter(Boolean))
  );
  out = stripLeadingSpeakerName(out, allNames);

  // Truncate if the model continued into another speaker's turn on a subsequent line
  const stopTargets = Array.from(
    new Set([...otherSpeakers, speakerLabel, 'Вы', 'Игрок', 'You', 'Player'].filter((n) => n && n.trim().length >= 2))
  );
  if (stopTargets.length > 0) {
    const alt = stopTargets.map((n) => escapeRegex(n.trim())).join('|');
    out = out.replace(new RegExp(`\\n+\\s*\\[?(?:${alt})\\]?\\s*:.*$`, 'is'), '');
  }

  out = cleanArtifacts(out);
  out = stripLeadingSpeakerName(out, allNames);
  return out.trim();
}

export async function suggestUserReply(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  userPersona: Character | null,
  prompt: string,
  recentHistory: string,
  options: SuggestUserReplyOptions = {}
): Promise<string> {
  const { system, userMsg, speakerLabel, otherSpeakers } = buildGhostwriterMessages({
    userPersona,
    prompt,
    recentHistory,
    userName: options.userName,
    otherSpeakers: options.otherSpeakers,
    language: options.language,
  });

  const extraStops = speakerStopStrings([speakerLabel, ...otherSpeakers, 'Вы', 'Игрок', 'You', 'Player']);
  const gwSamplers = RP_SAMPLER_PRESETS.roleplay;

  let out = '';
  try {
    await streamChatCompletion({
      apiKeyConfig,
      model: model || 'deepseek/deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      extraStops,
      temperature: 0.82,
      topP: gwSamplers.topP,
      minP: gwSamplers.minP,
      topK: gwSamplers.topK,
      repeatPenalty: gwSamplers.repeatPenalty,
      repeatLastN: gwSamplers.repeatLastN,
      frequencyPenalty: gwSamplers.frequencyPenalty,
      presencePenalty: gwSamplers.presencePenalty,
      signal: options.signal,
      onToken: (t) => {
        out += t;
        options.onPartial?.(cleanGhostwriterOutput(out, speakerLabel, otherSpeakers));
      },
      onError: (e) => { throw e; },
    });
  } catch (err: any) {
    // A stopped generation keeps the text received so far
    if (!options.signal?.aborted) throw err;
  }

  return cleanGhostwriterOutput(out, speakerLabel, otherSpeakers);
}

export interface CompressOptions {
  maxChars?: number;
  maxTokens?: number;
  timeoutMs?: number;
  isBackground?: boolean;
}

export async function compressChatHistory(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  messagesToCompress: Array<{ senderName: string; text: string }>,
  previousSummary?: string,
  options: CompressOptions = {}
): Promise<string> {
  const maxChars = options.maxChars ?? 1200;
  const maxTokens = options.maxTokens ?? 384;
  const timeoutMs = options.timeoutMs ?? 20000;
  const wordLimit = Math.round(maxChars / 7.5);
  const turns = messagesToCompress
    .filter((m) => m.text && m.text.trim().length > 0)
    .map((m) => `${m.senderName}: ${m.text.trim()}`)
    .join('\n');

  if (!turns) return previousSummary || '';

  const isRu = /[а-яА-ЯёЁ]/.test(turns + (previousSummary || ''));

  const system = isRu
    ? `Ты — литературный архивариус и летописец ролевой истории.
Твоя задача: составить предельно краткий, емкий и компактный пересказ (строго 1-3 коротких абзаца, не более ${wordLimit} слов) предшествующих событий сюжета.
Отрази ключевые решения, действия, смену отношений, тайны и факты, необходимые для сохранения контекста в долгих диалогах.
НЕ растягивай текст и не включай мелкую болтовню. Пиши на чистом русском языке без мета-вступлений. Выводи ТОЛЬКО сжатый пересказ.`
    : `You are an expert narrative chronicler for a roleplay story.
Your task: produce a strictly concise, compact summary (strictly 1-3 short paragraphs, max ${wordLimit} words) of earlier dialogue turns and story developments.
Highlight pivotal plot events, character decisions, secrets revealed, and relationship shifts needed to preserve long-term context.
Eliminate trivial chatter and keep it strictly bounded. Output ONLY the concise narrative recap with no meta introductions.`;

  const userContent = previousSummary
    ? (isRu
        ? `Предыдущий краткий пересказ:\n${previousSummary}\n\nНовые предшествующие реплики для включения в пересказ:\n${turns}`
        : `Previous context summary:\n${previousSummary}\n\nNew dialogue turns to incorporate into summary:\n${turns}`)
    : (isRu
        ? `Диалог для краткого пересказа:\n${turns}`
        : `Dialogue to summarize into concise context recap:\n${turns}`);

  let out = '';
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    await streamChatCompletion({
      apiKeyConfig,
      model: model || 'deepseek/deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0.35,
      maxTokens,
      isBackground: options.isBackground,
      signal: timeoutController.signal,
      onToken: (t) => { out += t; },
      onError: (e) => { throw e; },
    });
  } catch (err) {
    if (timeoutController.signal.aborted) {
      console.warn(`Chat history compression timed out after ${Math.round(timeoutMs / 1000)}s`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeoutId);
  }

  let summary = out.trim();
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars).trim() + '...';
  }
  return summary;
}

export async function summarizeScene(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  recentHistory: string,
  language: 'en' | 'ru' = 'ru'
): Promise<string> {
  const isRu = language === 'ru' || /[а-яА-ЯёЁ]/.test(recentHistory);
  const system = isRu
    ? `Ты — беспристрастный литературный рассказчик, подводящий итоги текущей ролевой сцены.
Напиши выразительную, атмосферную сводку из 2-3 абзацев на русском языке:
1. Текущее место действия и обстановка.
2. Что только что произошло и какое эмоциональное напряжение возникло между персонажами.
3. Активные конфликты, цели или невысказанные намерения.
Отвечай ТОЛЬКО на чистом литературном русском языке.`
    : `You are an impartial narrator summarizing the current roleplay scene.
Provide a clear, atmospheric 2-3 paragraph summary of:
1. Current location and situation.
2. What just happened and emotional tension between characters.
3. Active conflicts or unspoken intentions.
Respond in English.`;

  const userContent = isRu
    ? `Диалог и события сцены для составления сводки:\n\n${recentHistory}\n\nСоставь выразительную сводку на русском языке.`
    : `Scene dialogue and events to summarize:\n\n${recentHistory}\n\nProvide the scene summary in English.`;

  let out = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    onToken: (t) => { out += t; },
    onError: (e) => { throw e; },
  });

  return out.trim();
}
