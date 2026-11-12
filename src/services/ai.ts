import type { AiBackend, AiComponent, ApiKeyConfig, AppSettings, Character, CharacterEmotion, Group, Language } from '../types';

export const AI_COMPONENTS: AiComponent[] = ['chat', 'ghostwriter', 'memory', 'summary', 'characterGen', 'groupGen', 'vision'];

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export function normalizeLocalServerUrl(rawUrl: string): string {
  let url = (rawUrl || '').trim();
  if (!url) return 'http://192.168.1.55:8080/v1';

  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }

  url = url.replace(/\/+$/, '');

  if (!/\/v1$/i.test(url)) {
    url = `${url}/v1`;
  }

  return url;
}

export async function pingLocalServer(rawUrl: string): Promise<{
  ok: boolean;
  pingMs: number;
  activeModel?: string;
  error?: string;
}> {
  const normalized = normalizeLocalServerUrl(rawUrl);
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const modelsUrl = `${normalized}/models`;
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const pingMs = Math.max(1, Math.round(performance.now() - start));

    if (res.ok) {
      let activeModel: string | undefined;
      try {
        const data = await res.json();
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
          activeModel = data.data[0].id || data.data[0].name;
        } else if (data.models && Array.isArray(data.models) && data.models.length > 0) {
          activeModel = data.models[0].id || data.models[0].name;
        }
      } catch {
        // ignore json parse error
      }

      return {
        ok: true,
        pingMs,
        activeModel: activeModel || 'GGUF Local Model',
      };
    }

    const rootUrl = normalized.replace(/\/v1\/?$/, '');
    const healthRes = await fetch(`${rootUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    }).catch(() => null);

    if (healthRes && healthRes.ok) {
      const data = await healthRes.json().catch(() => ({}));
      return {
        ok: true,
        pingMs,
        activeModel: data.active_model || 'GGUF Local Model',
      };
    }

    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err.name === 'AbortError' || controller.signal.aborted;
    const msg = isAbort
      ? 'Таймаут подключения (сервер не ответил за 6 сек)'
      : (err.message || 'Ошибка подключения');
    return {
      ok: false,
      pingMs: 0,
      error: msg,
    };
  }
}

export interface LocalContextInfo {
  nCtx: number;
  recommendedPromptTokens: number;
  modelLoaded: boolean;
}

const localContextCache: { url: string; at: number; info: LocalContextInfo | null } = { url: '', at: 0, info: null };

/** Reads the loaded context size from the local hub so the chat can budget its prompt. */
export async function fetchLocalContextInfo(baseUrl: string, maxAgeMs = 15000): Promise<LocalContextInfo | null> {
  const url = normalizeLocalServerUrl(baseUrl);
  if (localContextCache.url === url && Date.now() - localContextCache.at < maxAgeMs) {
    return localContextCache.info;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  let info: LocalContextInfo | null = null;
  try {
    const res = await fetch(`${url}/models`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (res.ok) {
      const data = await res.json();
      const entry = Array.isArray(data?.data) ? data.data[0] : null;
      if (entry && Number(entry.context_length) > 0) {
        info = {
          nCtx: Number(entry.context_length),
          recommendedPromptTokens: Number(entry.recommended_prompt_tokens) || 0,
          modelLoaded: entry.loaded !== false,
        };
      }
    }
  } catch {
    info = null;
  } finally {
    clearTimeout(timeoutId);
  }
  localContextCache.url = url;
  localContextCache.at = Date.now();
  localContextCache.info = info;
  return info;
}

export function getEffectiveAiConfig(
  settings?: AppSettings,
  activeApiKey?: ApiKeyConfig
): {
  apiKeyConfig?: ApiKeyConfig;
  textModel: string;
  isLocal: boolean;
} {
  const { apiKeyConfig, textModel, isLocal } = getComponentAiConfig(settings, activeApiKey, 'chat');
  return { apiKeyConfig, textModel, isLocal };
}

/** Backend for one component: its own routing choice, otherwise the global engine mode. */
export function getComponentBackend(settings: AppSettings | undefined, component: AiComponent): AiBackend {
  const explicit = settings?.aiRouting?.[component];
  if (explicit) return explicit;
  return settings?.aiEngineMode === 'local' ? 'local' : 'cloud';
}

export function getComponentAiConfig(
  settings: AppSettings | undefined,
  activeApiKey: ApiKeyConfig | undefined,
  component: AiComponent
): {
  apiKeyConfig?: ApiKeyConfig;
  textModel: string;
  isLocal: boolean;
  backend: AiBackend;
} {
  const backend = getComponentBackend(settings, component);
  if (backend === 'local') {
    const baseUrl = normalizeLocalServerUrl(settings?.localHubUrl || 'http://192.168.1.55:8080/v1');
    return {
      apiKeyConfig: {
        id: 'local-hub',
        provider: 'custom',
        name: 'Local AI Hub (PC)',
        baseUrl,
        key: 'local-key',
        isActive: true,
      },
      textModel: 'local-model',
      isLocal: true,
      backend,
    };
  }
  const cloudModel = component === 'vision'
    ? (settings?.visionModel || settings?.textModel || 'google/gemini-flash-1.5')
    : (settings?.textModel || 'deepseek/deepseek-chat');
  return {
    apiKeyConfig: activeApiKey,
    textModel: cloudModel,
    isLocal: false,
    backend,
  };
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
    };

    if (apiKeyConfig.key && apiKeyConfig.key.trim()) {
      headers['Authorization'] = `Bearer ${apiKeyConfig.key.trim()}`;
    }

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
        stop: [
          'USER:',
          'User:',
          '\nUSER:',
          '\nUser:',
          '\n\nUSER:',
          '\n\nUser:',
          'ASSISTANT:',
          'Assistant:',
          '\nASSISTANT:',
          '\nAssistant:',
          '\n<user>',
          '\n<human>',
          '\nПользователь:',
          '<用户>',
          '<AI>',
        ],
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

    if (!res.body) {
      throw new Error('ReadableStream not supported by Gemini network response.');
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

    if (!res.body) {
      throw new Error('ReadableStream not supported by Anthropic network response.');
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
    // Strip tokenizer tokens like <|begin_of_sentence|>, < | begin__of__sentence | >, <|im_end|>, etc.
    .replace(/<\s*\|\s*[^>]+\s*\|\s*>/gi, '')
    // Strip simulated turns starting with <user> or User:
    .replace(/\n\s*<user>[\s\S]*$/gi, '')
    .replace(/\n\s*User:[\s\S]*$/gi, '')
    // Strip leading turn prefixes like <user>, <bot>, <assistant>, User:, Bot:, Assistant:
    .replace(/^\s*<user>[:\s]*/i, '')
    .replace(/^\s*<bot>[:\s]*/i, '')
    .replace(/^\s*<assistant>[:\s]*/i, '')
    .replace(/^\s*User:[:\s]*/i, '')
    .replace(/^\s*Bot:[:\s]*/i, '')
    .replace(/^\s*Assistant:[:\s]*/i, '')
    // Strip raw emotion tags and standalone bracket emotions from visible chat text
    .replace(/<emotion>[\s\S]*?<\/emotion>/gi, '')
    .replace(/<\s*emotion[:\s][^>]+>/gi, '')
    .replace(/(?:\[|<|\()(?:эмоция|emotion):\s*[^\]>\)]+(?:\]|>|\))/gi, '')
    .replace(/\[(neutral|happy|angry|sad|blushing|smirk|surprised|thoughtful|радость|счастье|улыбка|веселье|грусть|печаль|тоска|слезы|злость|гнев|ярость|раздражение|смущение|румянец|стыд|неловкость|усмешка|сарказм|ухмылка|удивление|шок|испуг|задумчивость|размышление|нейтральный|спокойствие)\]/gi, '')
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
export function extractEmotionAndCleanResponse(
  completed: string,
  characterEmotions?: CharacterEmotion[]
): ParsedBotResponse {
  if (!completed || !completed.trim()) {
    return { text: '' };
  }

  let finalEmotion: string | undefined = undefined;

  // 1. Match <emotion>...</emotion> anywhere in full generated response
  const emTagMatch = completed.match(/<emotion>([\s\S]*?)<\/emotion>/i);
  if (emTagMatch) {
    finalEmotion = emTagMatch[1].trim().toLowerCase();
  }

  // 2. Match [emotion: ...] or <emotion: ...> or (emotion: ...)
  if (!finalEmotion) {
    const emBracketMatch = completed.match(/(?:\[|<|\()(?:эмоция|emotion):\s*([^\]>\)]+)(?:\]|>|\))/i);
    if (emBracketMatch) {
      finalEmotion = emBracketMatch[1].trim().toLowerCase();
    }
  }

  // 3. Match standalone emotion brackets like [happy] or [радость]
  if (!finalEmotion) {
    const emWordMatch = completed.match(/\[(neutral|happy|angry|sad|blushing|smirk|surprised|thoughtful|радость|счастье|улыбка|веселье|грусть|печаль|тоска|слезы|злость|гнев|ярость|раздражение|смущение|румянец|стыд|неловкость|усмешка|сарказм|ухмылка|удивление|шок|испуг|задумчивость|размышление|нейтральный|спокойствие)\]/i);
    if (emWordMatch) {
      finalEmotion = emWordMatch[1].trim().toLowerCase();
    }
  }

  // Extract thoughts: <thought>...</thought>
  let finalThought = '';
  let visibleText = completed;

  const thoughtMatch = completed.match(/<thought>([\s\S]*?)<\/thought>/);
  if (thoughtMatch) {
    finalThought = thoughtMatch[1].trim();
    visibleText = completed.replace(/<thought>[\s\S]*?<\/thought>/, '').trim();
  } else if (visibleText.startsWith('<thought>')) {
    // Unclosed thought block
    finalThought = visibleText.replace('<thought>', '').trim();
    visibleText = '';
  }

  // Strip emotion tags from thought content if they leaked inside
  if (finalThought) {
    finalThought = finalThought
      .replace(/<emotion>[\s\S]*?<\/emotion>/gi, '')
      .replace(/<\s*emotion[:\s][^>]+>/gi, '')
      .replace(/(?:\[|<|\()(?:эмоция|emotion):\s*[^\]>\)]+(?:\]|>|\))/gi, '')
      .trim();
  }

  // 4. Fallback: if character has emotions configured, detect mood from actions, speech, and thoughts
  if (!finalEmotion && characterEmotions && characterEmotions.length > 0) {
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

  // Strip all emotion tags from visible text
  visibleText = visibleText
    .replace(/<emotion>[\s\S]*?<\/emotion>/gi, '')
    .replace(/<\s*emotion[:\s][^>]+>/gi, '')
    .replace(/(?:\[|<|\()(?:эмоция|emotion):\s*[^\]>\)]+(?:\]|>|\))/gi, '')
    .replace(/\[(neutral|happy|angry|sad|blushing|smirk|surprised|thoughtful|радость|счастье|улыбка|веселье|грусть|печаль|тоска|слезы|злость|гнев|ярость|раздражение|смущение|румянец|стыд|неловкость|усмешка|сарказм|ухмылка|удивление|шок|испуг|задумчивость|размышление|нейтральный|спокойствие)\]/gi, '');

  const cleaned = cleanArtifacts(visibleText);

  return {
    text: cleaned || cleanArtifacts(completed),
    thought: finalThought || undefined,
    emotion: finalEmotion,
  };
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

export async function suggestUserReply(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  userPersona: Character | null,
  prompt: string,
  recentHistory: string,
  options: { onPartial?: (text: string) => void; signal?: AbortSignal } = {}
): Promise<string> {
  const isRu = /[а-яА-ЯёЁ]/.test(recentHistory + (userPersona?.description || ''));
  const effectivePrompt = prompt && prompt.trim()
    ? prompt.trim()
    : (isRu
        ? 'Придумай наиболее логичное, интересное и живое продолжение реплики от лица игрока / персоны в текущей ситуации.'
        : 'Invent the most natural, clever, and compelling continuation of the dialogue on behalf of the player / persona in this scene.');

  const system = `You are a creative roleplay ghostwriter.
Based on the current ongoing scene and dialogue context, formulate what the user's persona should say and do next.
Match the language of the dialogue dynamically (if the conversation is in Russian, formulate in pure Russian; if in English, formulate in English, etc.).
Write actions and body language in *asterisks* and spoken dialogue in plain text.
Keep it natural, evocative, and strictly in character. Output ONLY the resulting action/speech with no meta explanation or quotation marks.`;

  const userMsg = `Scene History:\n${recentHistory}\n\nUser Persona: ${userPersona ? userPersona.name + ' (' + userPersona.description.slice(0, 200) + ')' : 'Player'}\n\nUser's Intent/Guidance: ${effectivePrompt}`;

  let out = '';
  try {
    await streamChatCompletion({
      apiKeyConfig,
      model: model || 'deepseek/deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.85,
      signal: options.signal,
      onToken: (t) => {
        out += t;
        options.onPartial?.(out.trim());
      },
      onError: (e) => { throw e; },
    });
  } catch (err: any) {
    // A stopped generation keeps the text received so far
    if (!options.signal?.aborted) throw err;
  }

  return out.trim();
}

export interface CompressOptions {
  maxChars?: number;
  maxTokens?: number;
  timeoutMs?: number;
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
