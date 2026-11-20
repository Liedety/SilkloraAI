import type { ApiKeyConfig } from '../../types';
import { findRepetitionBoundary, findForeignActorBoundary, findMetaLeakBoundary } from '../replyGuard.ts';
import { getProviderBaseUrl } from './config.ts';

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface StreamOptions {
  apiKeyConfig: ApiKeyConfig;
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  repeatPenalty?: number;
  repeatLastN?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  /** When true, forward reasoning_content deltas wrapped in <thought>...</thought>; otherwise drop them. */
  includeReasoning?: boolean;
  signal?: AbortSignal;
  /** Extra stop strings, e.g. "\nPersonaName:" so the model cannot start writing for the user. */
  extraStops?: string[];
  /** Names of the user and other characters: the stream is cut when the reply starts writing for them. */
  foreignNames?: string[];
  /** When true, marks automated background jobs (memory/summary) so Local Hub won't evict active Image Engine. */
  isBackground?: boolean;
  onToken: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError: (err: Error) => void;
}

export function findSimulatedTurnBoundary(text: string, opts: { foreignNames?: string[] } = {}): number {
  if (!text) return -1;
  const thoughtStrip = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  if (thoughtStrip.trim().length < 45) return -1;

  const patterns = [
    /(?:^|\s)>+\s*(?:f?user|assistant|model|human|bot)\b/i,
    /\n\s*(?:f?user|assistant)\s*(?=\r?\n)/i,
    /\n\s*---\s*\n\s*(?:f?user|assistant|user|model|\*\*)/i,
    /\n\s*\[\s*(?:Собеседник|Реплика\s+собеседника|Пользователь|User|Assistant)\s*[:\]]/i,
    /\n\s*---\s*\n\s*(?:Контекст\s+сцены|Текущий\s+контекст|Контекст\s+текущей\s+сцены|Scene\s+context|Current\s+scene|УКАЗАНИЕ\s+ПОЛЬЗОВАТЕЛЯ|USER\s+TURN\s+DIRECTIVE)/i,
    /\n\s*>+\s*\*\*(?:Имя|Пол|Год рождения|Возраст|Класс|Характеристики|Умения|Способности|Аппаратура|Name|Gender|Age|Class)\s*[:*]/i,
    /\n\s*(?:Пользователь|Игрок|Вы|User|Assistant|Player|You)\s*:\s*\S/,
    /(?:^|\s)>+\s*[\p{Lu}][\p{Ll}\p{L}-]{1,24}(?:\s*\([^)]+\))?\s*:/u,
  ];

  let earliest = -1;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index >= 40) {
      if (earliest === -1 || m.index < earliest) {
        earliest = m.index;
      }
    }
  }

  // Also abort multi-turn loops that emit 3+ separate <emotion> tags across paragraphs
  const emoMatches = Array.from(text.matchAll(/\n\s*<\s*(?:emotion|эмоция)\b/gi));
  if (emoMatches.length >= 2 && emoMatches[1].index !== undefined && emoMatches[1].index >= 80) {
    if (earliest === -1 || emoMatches[1].index < earliest) {
      earliest = emoMatches[1].index;
    }
  }

  const extra = [
    findRepetitionBoundary(text),
    findForeignActorBoundary(text, opts.foreignNames || [], 40),
    findMetaLeakBoundary(text, 40),
  ];
  for (const idx of extra) {
    if (idx >= 40 && (earliest === -1 || idx < earliest)) earliest = idx;
  }

  return earliest;
}

export async function streamChatCompletion(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, temperature = 0.85, maxTokens = 2048, signal, onToken, onComplete, onError } = options;

  const internalController = new AbortController();
  let stoppedForRunaway = false;
  let fullText = '';
  const forwardAbort = () => internalController.abort();
  signal?.addEventListener('abort', forwardAbort);

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

    const isLocalTarget =
      apiKeyConfig.id === 'local-hub' ||
      /^(https?:\/\/)?(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(baseUrl);
    if (options.isBackground && isLocalTarget) {
      headers['X-Silklora-Background'] = '1';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: internalController.signal,
      body: JSON.stringify((() => {
        const allStops = [
          ...(options.extraStops || []),
          'USER:',
          'User:',
          '\nUSER:',
          '\nUser:',
          '\n>user',
          '\n>fuser',
          '\n>assistant',
          '\n>model',
          '\nuser\n',
          '\nfuser\n',
          '\nassistant\n',
          'ASSISTANT:',
          'Assistant:',
          '\nASSISTANT:',
          '\nAssistant:',
          '\n<user>',
          '\n<human>',
          '\n[Собеседник:',
          '\n[Реплика',
          '\n[Пользователь:',
          '\nПользователь:',
          '\nВы:',
          '\nИгрок:',
          '\nYou:',
          '\nPlayer:',
          '<|turn>user',
          '<|turn>system',
          '<turn|>',
          '<start_of_turn>',
          '<end_of_turn>',
          '<|im_end|>',
          '<|im_start|>',
          '<|eot_id|>',
        ];
        const normalizedUrl = (apiKeyConfig.baseUrl || '').toLowerCase();
        const isOfficialOpenAI =
          apiKeyConfig.provider === 'openai' && (!normalizedUrl || normalizedUrl.includes('api.openai.com'));
        const isCustomOrLocal =
          apiKeyConfig.provider === 'custom' ||
          apiKeyConfig.provider === 'openrouter' ||
          normalizedUrl.includes('localhost') ||
          normalizedUrl.includes('127.0.0.1') ||
          normalizedUrl.includes('192.168.') ||
          normalizedUrl.includes('10.') ||
          normalizedUrl.includes('openrouter.ai');

        const payload: Record<string, unknown> = {
          model: model || 'deepseek/deepseek-chat',
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          stop: isOfficialOpenAI ? allStops.slice(0, 4) : allStops,
        };
        if (options.topP !== undefined) payload.top_p = options.topP;
        if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
        if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
        if (isCustomOrLocal) {
          if (options.minP !== undefined) payload.min_p = options.minP;
          if (options.topK !== undefined) payload.top_k = options.topK;
          if (options.repeatPenalty !== undefined) payload.repeat_penalty = options.repeatPenalty;
          if (options.repeatLastN !== undefined) payload.repeat_last_n = options.repeatLastN;
        }
        return payload;
      })()),
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
    let buffer = '';
    let reasoningOpen = false;
    const includeReasoning = Boolean(options.includeReasoning);

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
          let data: any;
          try {
            data = JSON.parse(trimmed.slice(6));
          } catch {
            // ignore partial JSON parse error
            continue;
          }
          if (data?.error) {
            const msg = typeof data.error === 'string' ? data.error : data.error?.message || JSON.stringify(data.error);
            throw new Error(`API Stream Error: ${msg}`);
          }
          const choiceDelta = data.choices?.[0]?.delta;
          const reasoningChunk = choiceDelta?.reasoning_content ?? choiceDelta?.reasoning;
          if (typeof reasoningChunk === 'string' && reasoningChunk && includeReasoning) {
            const out = reasoningOpen ? reasoningChunk : `<thought>${reasoningChunk}`;
            reasoningOpen = true;
            fullText += out;
            onToken(out);
          }
          const delta = choiceDelta?.content ?? data.choices?.[0]?.message?.content;
          if (delta) {
            const out = reasoningOpen ? `</thought>\n${delta}` : delta;
            reasoningOpen = false;
            fullText += out;
            const boundary = findSimulatedTurnBoundary(fullText, { foreignNames: options.foreignNames });
            if (boundary !== -1) {
              fullText = fullText.slice(0, boundary).trimEnd();
              stoppedForRunaway = true;
              internalController.abort();
              break;
            }
            onToken(out);
          }
        }
      }
      if (stoppedForRunaway) break;
    }

    if (reasoningOpen) {
      const closeTag = '</thought>';
      fullText += closeTag;
      onToken(closeTag);
    }

    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    if (stoppedForRunaway) {
      onComplete?.(fullText);
      return;
    }
    onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
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
