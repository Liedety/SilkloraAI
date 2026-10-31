import type { ApiKeyConfig, Character, Group, Language } from '../types';

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface StreamOptions {
  apiKeyConfig: ApiKeyConfig;
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError: (err: Error) => void;
}

function getProviderBaseUrl(config: ApiKeyConfig): string {
  if (config.baseUrl && config.baseUrl.trim()) {
    return config.baseUrl.trim().replace(/\/+$/, '');
  }
  switch (config.provider) {
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    default:
      return 'https://openrouter.ai/api/v1';
  }
}

export async function streamChatCompletion(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, temperature = 0.85, maxTokens = 2048, signal, onToken, onComplete, onError } = options;

  try {
    if (apiKeyConfig.provider === 'gemini') {
      await streamGemini(options);
      return;
    }
    if (apiKeyConfig.provider === 'anthropic') {
      await streamAnthropic(options);
      return;
    }

    // Standard OpenAI-compatible format (OpenRouter, OpenAI, Groq, DeepSeek, Custom)
    const baseUrl = getProviderBaseUrl(apiKeyConfig);
    const url = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKeyConfig.key.trim()}`,
    };

    if (apiKeyConfig.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://silklora.ai';
      headers['X-Title'] = 'SilkloraAI';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: model || 'deepseek/deepseek-chat',
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API Error (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error('ReadableStream not supported by the network response.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') {
          continue;
        }
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              onToken(delta);
            }
          } catch {
            // ignore partial JSON parse error
          }
        }
      }
    }

    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

async function streamGemini(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, onToken, onComplete, onError, signal } = options;
  try {
    const modelName = model || 'gemini-1.5-flash';
    const cleanModel = modelName.startsWith('google/') ? modelName.replace('google/', '') : modelName;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse&key=${apiKeyConfig.key.trim()}`;

    // Convert OpenAI messages to Gemini contents
    let systemInstruction = '';
    const contents: Array<{ role: string; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      } else {
        const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
        if (typeof msg.content === 'string') {
          contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
          const parts: any[] = [];
          for (const p of msg.content) {
            if (p.type === 'text' && p.text) {
              parts.push({ text: p.text });
            } else if (p.type === 'image_url' && p.image_url?.url) {
              const base64Match = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
              if (base64Match) {
                parts.push({
                  inline_data: {
                    mime_type: base64Match[1],
                    data: base64Match[2],
                  },
                });
              }
            }
          }
          contents.push({ role: geminiRole, parts });
        }
      }
    }

    const payload: any = { contents };
    if (systemInstruction.trim()) {
      payload.systemInstruction = { parts: [{ text: systemInstruction.trim() }] };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Error (${res.status}): ${errText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const textChunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textChunk) {
              fullText += textChunk;
              onToken(textChunk);
            }
          } catch {}
        }
      }
    }
    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

async function streamAnthropic(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, onToken, onComplete, onError, signal } = options;
  try {
    const url = 'https://api.anthropic.com/v1/messages';
    let systemPrompt = '';
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: any }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      } else {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeyConfig.key.trim(),
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify({
        model: model || 'claude-3-5-sonnet-20241022',
        system: systemPrompt,
        messages: anthropicMessages,
        max_tokens: 2048,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic Error (${res.status}): ${errText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.type === 'content_block_delta' && data.delta?.text) {
              fullText += data.delta.text;
              onToken(data.delta.text);
            }
          } catch {}
        }
      }
    }
    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function fetchAvailableModels(apiKeyConfig: ApiKeyConfig): Promise<Array<{ id: string; name: string; pricing?: { prompt: number } }>> {
  if (apiKeyConfig.provider === 'openrouter') {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (res.ok) {
        const data = await res.json();
        return (data.data || []).map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          pricing: {
            prompt: parseFloat(m.pricing?.prompt || '0'),
          },
        }));
      }
    } catch {
      // fallback
    }
  }

  // Fallback defaults for popular providers
  return [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (Fast & Uncensored RP)', pricing: { prompt: 0.0001 } },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Deep Reasoning)', pricing: { prompt: 0.0005 } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Elite Quality)', pricing: { prompt: 0.003 } },
    { id: 'openai/gpt-4o', name: 'GPT-4o (Multimodal & Fast)', pricing: { prompt: 0.0025 } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (Free/Cheap)', pricing: { prompt: 0 } },
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free)', pricing: { prompt: 0 } },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', pricing: { prompt: 0.0002 } },
    { id: 'nousresearch/hermes-3-llama-3.1-405b', name: 'Hermes 3 405B (Uncensored)', pricing: { prompt: 0.001 } },
  ];
}

export async function fetchVisionModels(
  apiKeyConfig?: ApiKeyConfig
): Promise<Array<{ id: string; name: string; pricing?: { prompt: number } }>> {
  if (apiKeyConfig && apiKeyConfig.provider === 'openrouter' && apiKeyConfig.key.trim()) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKeyConfig.key.trim()}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        const list = (data.data || []).filter((m: any) => {
          const id = (m.id || '').toLowerCase();
          const desc = (m.description || '').toLowerCase();
          const modalities = m.architecture?.modality || '';
          return (
            modalities.includes('image') ||
            id.includes('vision') ||
            id.includes('vl') ||
            id.includes('gemini') ||
            id.includes('gpt-4o') ||
            id.includes('claude-3') ||
            desc.includes('multimodal') ||
            desc.includes('vision')
          );
        });

        if (list.length > 0) {
          return list.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            pricing: {
              prompt: parseFloat(m.pricing?.prompt || '0'),
            },
          }));
        }
      }
    } catch {
      // fallback
    }
  }

  return [
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Vision (Free)', pricing: { prompt: 0 } },
    { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash (Fast Multimodal)', pricing: { prompt: 0.0001 } },
    { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro (Deep Multimodal)', pricing: { prompt: 0.00125 } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini Vision (Budget Fast)', pricing: { prompt: 0.00015 } },
    { id: 'openai/gpt-4o', name: 'GPT-4o (High Detail Vision)', pricing: { prompt: 0.0025 } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Vision Elite)', pricing: { prompt: 0.003 } },
    { id: 'qwen/qwen-2-vl-72b-instruct', name: 'Qwen 2 VL 72B (Open Weights)', pricing: { prompt: 0.0004 } },
    { id: 'meta-llama/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision (Free/Cheap)', pricing: { prompt: 0 } },
  ];
}

export function cleanArtifacts(str: string): string {
  if (!str) return '';
  return str
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

export async function generatePersonaWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  concept: string,
  dos: string,
  donts: string,
  photoRef?: string,
  contextLore?: string,
  language: Language = 'en'
): Promise<{ name: string; description: string; greeting: string }> {
  const isRu = language === 'ru';
  const languageInstruction = isRu
    ? `ВАЖНО: Язык генерации — РУССКИЙ. Все поля ("name", "description", "greeting") ОБЯЗАТЕЛЬНО должны быть написаны на чистом, выразительном русском языке. Никаких английских слов.`
    : `Language: English.`;

  const systemPrompt = `You are an elite creative director for deep, unrestricted roleplay characters.
Given a concept and preferences, generate an extraordinarily detailed, distinct, and compelling roleplay persona.
${languageInstruction}

Return STRICT JSON only matching this exact format:
{
  "name": "Character Name",
  "description": "Exhaustive description covering: personality traits, dark secrets, speech patterns, appearance, background lore, vulnerabilities, habits.",
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

  const user = `Group: ${groupName}\nLore: ${groupDescription}\n\nMembers:\n${charProfiles}`;

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

export async function suggestUserReply(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  userPersona: Character | null,
  prompt: string,
  recentHistory: string
): Promise<string> {
  const system = `You are a roleplay ghostwriter.
Based on the current scene and the user's intent, formulate what the user's persona should say and do.
Write actions in *asterisks* and spoken dialogue in plain text.
Keep it natural, in-character, and direct. Output ONLY the resulting action/speech with no meta explanation.`;

  const userMsg = `Scene History:\n${recentHistory}\n\nUser Persona: ${userPersona ? userPersona.name + ' (' + userPersona.description.slice(0, 200) + ')' : 'Player'}\n\nUser's Intent/Guidance: ${prompt}`;

  let out = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.85,
    onToken: (t) => { out += t; },
    onError: (e) => { throw e; },
  });

  return out.trim();
}

export async function summarizeScene(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  recentHistory: string
): Promise<string> {
  const system = `You are an impartial narrator summarizing the current roleplay scene.
Provide a clear, atmospheric 2-3 paragraph summary of:
1. Current location and situation.
2. What just happened and emotional tension between characters.
3. Active conflicts or unspoken intentions.`;

  let out = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: recentHistory },
    ],
    temperature: 0.7,
    onToken: (t) => { out += t; },
    onError: (e) => { throw e; },
  });

  return out.trim();
}
