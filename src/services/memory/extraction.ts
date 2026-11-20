import { db } from '../../db/index.ts';
import type { ApiKeyConfig, ChatMessage, MemoryEdge, MemoryNode } from '../../types/index.ts';
import { streamChatCompletion } from '../ai.ts';
import { isTrivialActionNode, normalizeLabel } from './scoring.ts';
import { isSignificantTurn } from './stateFacts.ts';
import { _pruneAndConsolidateUnlocked, removeMemoriesWithBridge, withChatMemoryLock } from './store.ts';

const VALID_MEMORY_TYPES = new Set<MemoryNode['type']>(['event', 'fact', 'relationship', 'location', 'secret']);

/** Extracts lasting narrative memories and affinity updates after a character turn. */
export async function extractMemoryAndAffinity(
  chatId: string,
  _characterId: string,
  currentAffinity: number,
  recentMessages: ChatMessage[],
  apiKeyConfig?: ApiKeyConfig,
  model?: string,
  messageId?: string
): Promise<{ newAffinity: number; newNodes: MemoryNode[] }> {
  if (messageId) {
    try {
      await removeMemoriesWithBridge({ chatId, messageIds: [messageId], respectPinned: true });
    } catch (err) {
      console.warn('Failed to clean up stale nodes for turn:', err);
    }
  }

  let targetBotMsg = messageId
    ? recentMessages.find((m) => m.id === messageId)
    : undefined;
  if (!targetBotMsg) {
    targetBotMsg = [...recentMessages].reverse().find((m) => m.senderId !== 'user');
  }

  if (!targetBotMsg) {
    return { newAffinity: currentAffinity, newNodes: [] };
  }

  const botIdx = recentMessages.findIndex((m) => m.id === targetBotMsg!.id);
  const prevUser = botIdx !== -1
    ? [...recentMessages.slice(0, botIdx)].reverse().find((m) => m.senderId === 'user')
    : undefined;
  const lastUserMsg = prevUser || [...recentMessages].reverse().find((m) => m.senderId === 'user');

  if (!lastUserMsg) {
    return { newAffinity: currentAffinity, newNodes: [] };
  }

  const userText = lastUserMsg.variants[lastUserMsg.activeVariantIndex]?.text || '';
  const botText = targetBotMsg.variants[targetBotMsg.activeVariantIndex]?.text || '';
  const isDialogueRu = /[а-яА-ЯёЁ]/.test(userText + botText);

  // Skip routine physical movements/small talk early — physical poses/clothes belong to SceneState, NOT long-term memory!
  if (!isSignificantTurn(userText, botText, 0) && userText.trim().length < 80) {
    return { newAffinity: currentAffinity, newNodes: [] };
  }

  if (apiKeyConfig && (apiKeyConfig.key.trim() || apiKeyConfig.provider === 'custom')) {
    let rawResponse = '';
    try {
      const extractionPrompt = isDialogueRu
        ? `Проанализируй этот ход ролевой истории между ПОЛЬЗОВАТЕЛЕМ и ПЕРСОНАЖЕМ.
1. Оцени изменение симпатии/доверия персонажа к пользователю (число от -10 до +10).
2. Проверь, произошло ли СЮЖЕТНО ВАЖНОЕ СОБЫТИЕ, которое обязательно нужно помнить спустя 50 сообщений.

СТРОГИЙ ФИЛЬТР ДОЛГОСРОЧНОЙ ПАМЯТИ:
- КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО записывать обычные действия, позы и бытовые мелочи: кто куда сел, встал, подошёл, посмотрел, улыбнулся, кивнул, вздохнул, налил чай, надел куртку или просто поболтал.
- Записывай узел ТОЛЬКО если произошло одно из следующего:
  1) раскрыта важная тайна, прошлое или личный факт биографии ("secret" / "fact");
  2) дано обещание, клятва, заключён договор или получено сюжетно важное задание/предмет ("event" / "fact");
  3) произошёл перелом в отношениях — признание, поцелуй, предательство, серьёзная ссора или спасение жизни ("relationship");
  4) герои впервые прибыли в ключевое сюжетное место ("location").
- Если ничего такого не было — ОБЯЗАТЕЛЬНО верни пустой массив: "nodes": []. Максимум 1 узел за ход.
- Пиши "label" и "detail" на русском языке.

ПОЛЬЗОВАТЕЛЬ: ${userText}
ПЕРСОНАЖ: ${botText}

Ответь СТРОГО чистым JSON без markdown:
{
  "affinityDelta": 0,
  "nodes": [
    {
      "label": "Суть важного факта (2-5 слов)",
      "type": "secret" | "fact" | "relationship" | "event" | "location",
      "detail": "Одно конкретное предложение: кто, что именно пообещал/раскрыл/изменил и почему это важно."
    }
  ]
}`
        : `Analyze this roleplay turn between USER and CHARACTER.
1. Estimate how the character's trust/affinity toward the user changed (-10 to +10).
2. Check if a GENUINELY PLOT-CRITICAL MILESTONE occurred that must still be remembered 50 turns later.

STRICT LONG-TERM MEMORY FILTER:
- NEVER record routine physical actions, postures, or everyday gestures: sitting down, standing up, walking over, smiling, nodding, sighing, drinking tea, putting on clothes, or casual banter.
- Create a node ONLY when one of these happens:
  1) a major secret, backstory reveal, or core personal fact is uncovered ("secret" / "fact");
  2) an oath, promise, pact, or plot-critical quest/artifact changes hands ("event" / "fact");
  3) a true relationship turning point occurs — confession, betrayal, major rift, or saving a life ("relationship");
  4) arrival at a major new story location ("location").
- Otherwise "nodes" MUST be an empty array: "nodes": []. At most 1 node per turn.
- Write "label" and "detail" in the dialogue language.

USER: ${userText}
CHARACTER: ${botText}

Respond STRICTLY with raw JSON (no markdown):
{
  "affinityDelta": 0,
  "nodes": [
    {
      "label": "Core Milestone (3-5 words)",
      "type": "secret" | "fact" | "relationship" | "event" | "location",
      "detail": "One specific sentence stating the exact secret, promise, fact, or turning point."
    }
  ]
}`;

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), 15000);
      try {
        await streamChatCompletion({
          apiKeyConfig,
          model: model || 'deepseek/deepseek-chat',
          messages: [
            { role: 'system', content: 'You are a selective long-term story memory curator. Output valid JSON only.' },
            { role: 'user', content: extractionPrompt },
          ],
          temperature: 0.15,
          maxTokens: 220,
          isBackground: true,
          signal: timeoutController.signal,
          onToken: (tok) => {
            rawResponse += tok;
          },
          onError: () => {},
        });
      } finally {
        clearTimeout(timeoutId);
      }

      let cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
      const parsed = JSON.parse(cleaned);

      const delta = typeof parsed.affinityDelta === 'number' ? Math.max(-10, Math.min(10, parsed.affinityDelta)) : 0;
      const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));

      const createdNodes: MemoryNode[] = [];
      const isSignificant = isSignificantTurn(userText, botText, delta);
      await withChatMemoryLock(chatId, async () => {
        if (isSignificant && Array.isArray(parsed.nodes)) {
          // If the target turn was deleted/regenerated while background LLM extraction was in flight, skip writing stale nodes
          if (messageId) {
            const totalChatMsgs = await db.messages.where('chatId').equals(chatId).count();
            if (totalChatMsgs > 0) {
              const stillExists = await db.messages.get(messageId);
              if (!stillExists) return;
            }
          }
          const liveMsgs = await db.messages.where('chatId').equals(chatId).primaryKeys();
          const liveMsgSet = new Set(liveMsgs);

          await db.transaction('rw', db.memoryNodes, db.memoryEdges, async () => {
            for (const item of parsed.nodes.slice(0, 2)) {
              const rawLabel = typeof item?.label === 'string' ? item.label.trim() : '';
              const rawDetail = typeof item?.detail === 'string' ? item.detail.trim() : '';
              const nodeType: MemoryNode['type'] = VALID_MEMORY_TYPES.has(item?.type) ? item.type : 'fact';

              if (!rawLabel || !rawDetail) continue;
              if (isTrivialActionNode({ label: rawLabel, detail: rawDetail, type: nodeType })) {
                continue;
              }

              const norm = normalizeLabel(rawLabel);
              const existingInChat = await db.memoryNodes.where('chatId').equals(chatId).sortBy('createdAt');
              const duplicate = existingInChat.find((n) => normalizeLabel(n.label) === norm);

              if (duplicate) {
                const candidateMsgId = messageId || duplicate.messageId;
                const finalMessageId =
                  candidateMsgId && (liveMsgSet.size === 0 || liveMsgSet.has(candidateMsgId))
                    ? candidateMsgId
                    : undefined;
                const mergedDetail = rawDetail.length > duplicate.detail.length ? rawDetail : duplicate.detail;
                await db.memoryNodes.update(duplicate.id, {
                  messageId: finalMessageId,
                  detail: mergedDetail,
                  createdAt: Date.now(),
                });
                createdNodes.push({ ...duplicate, messageId: finalMessageId, detail: mergedDetail });
              } else {
                const node: MemoryNode = {
                  id: 'node-' + Math.random().toString(36).substring(2, 10),
                  chatId,
                  messageId,
                  label: rawLabel,
                  type: nodeType,
                  detail: rawDetail,
                  createdAt: Date.now(),
                };
                await db.memoryNodes.put(node);
                createdNodes.push(node);

                if (existingInChat.length > 0) {
                  const prev = existingInChat[existingInChat.length - 1];
                  const edge: MemoryEdge = {
                    id: 'edge-' + Math.random().toString(36).substring(2, 10),
                    chatId,
                    source: prev.id,
                    target: node.id,
                    label: isDialogueRu ? 'приводит к' : 'leads to',
                  };
                  await db.memoryEdges.put(edge);
                }
              }
            }
          });
        }
        await _pruneAndConsolidateUnlocked(chatId, 36);
      });
      return { newAffinity, newNodes: createdNodes };
    } catch {
      const deltaM = rawResponse.match(/"affinityDelta"\s*:\s*(-?\d+)/);
      if (deltaM) {
        const delta = parseInt(deltaM[1], 10);
        if (!isNaN(delta)) {
          const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));
          return { newAffinity, newNodes: [] };
        }
      }
    }
  }

  // Fallback affinity estimation when background AI is deferred or offline (does NOT spam generic memory nodes)
  let delta = 0;
  const lower = (userText + ' ' + botText).toLowerCase();

  const positiveWords = [
    'спасибо', 'благодар', 'нравиш', 'любл', 'обня', 'поцелу', 'друг', 'помогу', 'помощь',
    'вместе', 'доверя', 'береги', 'защищ', 'thank', 'love', 'care', 'friend', 'help', 'trust', 'kiss', 'protect',
  ];
  const negativeWords = [
    'ненавижу', 'убить', 'предател', 'мразь', 'урод', 'дурак', 'исчезни', 'пошел вон',
    'лжец', 'враг', 'удар', 'выстрел', 'угрож', 'hate', 'kill', 'traitor', 'fool', 'disappear',
    'enemy', 'liar', 'strike', 'threat',
  ];

  let posCount = 0;
  for (const w of positiveWords) {
    if (lower.includes(w)) posCount++;
  }
  let negCount = 0;
  for (const w of negativeWords) {
    if (lower.includes(w)) negCount++;
  }

  if (posCount > negCount) {
    delta = Math.min(5, 1 + posCount);
  } else if (negCount > posCount) {
    delta = -Math.min(7, 2 + negCount * 2);
  }

  const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));
  return { newAffinity, newNodes: [] };
}
