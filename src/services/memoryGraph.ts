import { db } from '../db/index.ts';
import type { ApiKeyConfig, MemoryNode, MemoryEdge, ChatMessage } from '../types/index.ts';
import { streamChatCompletion } from './ai.ts';

/**
 * Normalizes a string for deduplication (trims, lowercases, removes trailing punctuation).
 */
export function normalizeLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s.,!?:;…]+$/, '')
    .trim();
}

/**
 * Calculates priority score for a memory node.
 * Higher score = more important, less likely to be pruned.
 * Pinned nodes return Infinity (never pruned).
 */
export function calculateNodeScore(
  node: MemoryNode,
  degree: number = 0,
  minTime: number = 0,
  maxTime: number = 0
): number {
  if (node.isPinned) return Infinity;

  // Base priority by memory type
  let typeScore = 10;
  switch (node.type) {
    case 'secret':
      typeScore = 35;
      break;
    case 'relationship':
      typeScore = 30;
      break;
    case 'fact':
      typeScore = 25;
      break;
    case 'location':
      typeScore = 20;
      break;
    case 'event':
      typeScore = 10;
      break;
  }

  // Interconnectivity bonus: nodes linked to many other memories are central knowledge
  const degreeBonus = degree * 5;

  // Recency bonus: recent memories get up to 20 bonus points
  let recencyBonus = 10;
  if (maxTime > minTime) {
    recencyBonus = Math.round(((node.createdAt - minTime) / (maxTime - minTime)) * 20);
  }

  // Penalty for raw fallback dialogue quotes
  let detailPenalty = 0;
  if (
    node.detail.startsWith('User said:') ||
    node.detail.startsWith('Пользователь:') ||
    node.label.endsWith('...')
  ) {
    detailPenalty = 20;
  }

  return typeScore + degreeBonus + recencyBonus - detailPenalty;
}

/**
 * Finds groups of duplicate memory nodes based on normalized label.
 */
export function findDuplicateNodes(nodes: MemoryNode[]): { survivor: MemoryNode; duplicates: MemoryNode[] }[] {
  const groups: Record<string, MemoryNode[]> = {};

  for (const node of nodes) {
    const key = normalizeLabel(node.label);
    if (!groups[key]) groups[key] = [];
    groups[key].push(node);
  }

  const results: { survivor: MemoryNode; duplicates: MemoryNode[] }[] = [];

  for (const group of Object.values(groups)) {
    if (group.length > 1) {
      // Pick survivor: prefer pinned, then richest detail, then most recent
      const sorted = [...group].sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        if (b.detail.length !== a.detail.length) return b.detail.length - a.detail.length;
        return b.createdAt - a.createdAt;
      });

      const survivor = sorted[0];
      const duplicates = sorted.slice(1);
      results.push({ survivor, duplicates });
    }
  }

  return results;
}

/**
 * Pure function: Selects lowest priority unpinned nodes to prune when total nodes exceed maxNodes.
 */
export function selectNodesToPrune(
  nodes: MemoryNode[],
  edges: MemoryEdge[] = [],
  maxNodes: number = 30
): MemoryNode[] {
  if (nodes.length <= maxNodes) return [];

  // Calculate degrees
  const degrees: Record<string, number> = {};
  for (const edge of edges) {
    degrees[edge.source] = (degrees[edge.source] || 0) + 1;
    degrees[edge.target] = (degrees[edge.target] || 0) + 1;
  }

  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const n of nodes) {
    if (n.createdAt < minTime) minTime = n.createdAt;
    if (n.createdAt > maxTime) maxTime = n.createdAt;
  }

  // Separate pinned vs unpinned
  const unpinned = nodes.filter((n) => !n.isPinned);
  const excess = nodes.length - maxNodes;

  if (excess <= 0 || unpinned.length === 0) return [];

  // Sort unpinned by score ascending (lowest score first)
  const sorted = [...unpinned].sort((a, b) => {
    const scoreA = calculateNodeScore(a, degrees[a.id] || 0, minTime, maxTime);
    const scoreB = calculateNodeScore(b, degrees[b.id] || 0, minTime, maxTime);
    return scoreA - scoreB;
  });

  return sorted.slice(0, Math.min(excess, unpinned.length));
}

/**
 * Consolidates duplicate memory nodes and prunes lower-priority nodes to prevent context bloat.
 */
export async function pruneAndConsolidateMemories(
  chatId: string,
  maxNodes: number = 30
): Promise<{ prunedCount: number; consolidatedCount: number }> {
  let consolidatedCount = 0;
  let prunedCount = 0;

  try {
    // Phase 1: Consolidate duplicate nodes
    const allNodes = await db.memoryNodes.where('chatId').equals(chatId).toArray();
    const duplicateGroups = findDuplicateNodes(allNodes);

    for (const { survivor, duplicates } of duplicateGroups) {
      for (const dup of duplicates) {
        // Re-route incoming edges
        const incoming = await db.memoryEdges.where('target').equals(dup.id).toArray();
        for (const inc of incoming) {
          if (inc.source !== survivor.id) {
            const exists = await db.memoryEdges
              .where('chatId')
              .equals(chatId)
              .filter((e) => e.source === inc.source && e.target === survivor.id)
              .first();
            if (!exists) {
              await db.memoryEdges.put({
                id: 'edge-' + Math.random().toString(36).substring(2, 10),
                chatId,
                source: inc.source,
                target: survivor.id,
                label: inc.label,
              });
            }
          }
          await db.memoryEdges.delete(inc.id);
        }

        // Re-route outgoing edges
        const outgoing = await db.memoryEdges.where('source').equals(dup.id).toArray();
        for (const out of outgoing) {
          if (out.target !== survivor.id) {
            const exists = await db.memoryEdges
              .where('chatId')
              .equals(chatId)
              .filter((e) => e.source === survivor.id && e.target === out.target)
              .first();
            if (!exists) {
              await db.memoryEdges.put({
                id: 'edge-' + Math.random().toString(36).substring(2, 10),
                chatId,
                source: survivor.id,
                target: out.target,
                label: out.label,
              });
            }
          }
          await db.memoryEdges.delete(out.id);
        }

        // Delete duplicate node
        await db.memoryNodes.delete(dup.id);
        consolidatedCount++;
      }
    }

    // Phase 2: Prune lowest-priority nodes if count exceeds maxNodes
    const currentNodes = await db.memoryNodes.where('chatId').equals(chatId).toArray();
    if (currentNodes.length > maxNodes) {
      const currentEdges = await db.memoryEdges.where('chatId').equals(chatId).toArray();
      const nodesToPrune = selectNodesToPrune(currentNodes, currentEdges, maxNodes);

      for (const node of nodesToPrune) {
        // Bridge adjacent edges to preserve graph flow
        const incoming = currentEdges.filter((e) => e.target === node.id);
        const outgoing = currentEdges.filter((e) => e.source === node.id);

        for (const inc of incoming) {
          for (const out of outgoing) {
            if (
              inc.source !== out.target &&
              !nodesToPrune.some((p) => p.id === inc.source || p.id === out.target)
            ) {
              const alreadyLinked = currentEdges.some(
                (e) => e.source === inc.source && e.target === out.target
              );
              if (!alreadyLinked) {
                await db.memoryEdges.put({
                  id: 'edge-' + Math.random().toString(36).substring(2, 10),
                  chatId,
                  source: inc.source,
                  target: out.target,
                  label: inc.label || out.label,
                });
              }
            }
          }
        }

        // Remove connected edges and delete node
        await db.memoryEdges.where('source').equals(node.id).delete();
        await db.memoryEdges.where('target').equals(node.id).delete();
        await db.memoryNodes.delete(node.id);
        prunedCount++;
      }
    }
  } catch (err) {
    console.warn('Memory pruning/consolidation error:', err);
  }

  return { prunedCount, consolidatedCount };
}

export function isSignificantTurn(userText: string, botText: string, affinityDelta: number = 0): boolean {
  const trimmedUser = userText.trim();
  if (!trimmedUser) return false;

  // Trivial everyday greetings or short affirmations/acknowledgments/chit-chat
  const isTrivial =
    /^(?:привет|здравствуй(?:те)?|добрый (?:день|вечер|утро)|хай|ку|салют|hello|hi|hey|howdy|sup|good (?:morning|evening|day))[\s.!?,]*$/i.test(trimmedUser) ||
    /^(?:да|нет|ок|окей|хорошо|ладно|понял|понятно|ясно|ага|угу|спасибо|yes|no|ok|okay|sure|fine|yep|nope|thanks|thank you)[\s.!?,]*$/i.test(trimmedUser) ||
    /^(?:как дела|как твои дела|как поживаешь|что делаешь|что новенького|how are you|how is it going|how are things|what are you doing|what's up)[\s.!?]*$/i.test(trimmedUser) ||
    /^(?:привет|здравствуй|хай|hello|hi)[\s\S]{0,25}(?:как (?:дела|ты|поживаешь)|how are you|how'?s it going)[\s.!?]*$/i.test(trimmedUser);

  if (isTrivial && Math.abs(affinityDelta) < 3) {
    return false;
  }

  // Strong affinity or relationship milestone shift
  if (Math.abs(affinityDelta) >= 3) {
    return true;
  }

  const combined = (userText + ' ' + botText).toLowerCase();
  const significantKeywords = [
    'секрет', 'тайна', 'клятв', 'обеща', 'люблю', 'ненавиж', 'убью', 'удар', 'выстрел',
    'погиб', 'смерт', 'опасн', 'предател', 'союз', 'брак', 'артефакт', 'кровь', 'враг',
    'правд', 'ложь', 'заговор', 'secret', 'promise', 'swear', 'confess', 'danger', 'betray',
    'kill', 'death', 'love', 'hate', 'weapon', 'alliance', 'blood', 'enemy', 'artifact',
    'truth', 'mystery', 'reveal',
  ];

  if (significantKeywords.some((w) => combined.includes(w)) && trimmedUser.length >= 20) {
    return true;
  }

  // Significant descriptive development with emotional weight
  return trimmedUser.length >= 75 && Math.abs(affinityDelta) >= 1;
}

export async function extractMemoryAndAffinity(
  chatId: string,
  characterId: string,
  currentAffinity: number,
  recentMessages: ChatMessage[],
  apiKeyConfig?: ApiKeyConfig,
  model?: string,
  messageId?: string
): Promise<{ newAffinity: number; newNodes: MemoryNode[] }> {
  // If regenerating or adding new variant to existing turn, clean up stale nodes from previous generations of that turn
  if (messageId) {
    try {
      const staleNodes = await db.memoryNodes
        .where('chatId')
        .equals(chatId)
        .filter((n) => n.messageId === messageId)
        .toArray();

      for (const sn of staleNodes) {
        if (sn.isPinned) continue; // Pinned memories are permanent and must never be deleted!

        // Bridge edges around deleted stale node to keep memory graph connected
        const incoming = await db.memoryEdges.where('target').equals(sn.id).toArray();
        const outgoing = await db.memoryEdges.where('source').equals(sn.id).toArray();
        for (const inc of incoming) {
          for (const out of outgoing) {
            if (inc.source !== out.target) {
              const exists = await db.memoryEdges
                .where('chatId')
                .equals(chatId)
                .filter((e) => e.source === inc.source && e.target === out.target)
                .first();
              if (!exists) {
                await db.memoryEdges.put({
                  id: 'edge-' + Math.random().toString(36).substring(2, 10),
                  chatId,
                  source: inc.source,
                  target: out.target,
                  label: inc.label || out.label,
                });
              }
            }
          }
        }

        await db.memoryEdges.where('source').equals(sn.id).delete();
        await db.memoryEdges.where('target').equals(sn.id).delete();
        await db.memoryNodes.delete(sn.id);
      }
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

  // Fast-path: if this turn is completely trivial small talk with 0 affinity delta,
  // skip memory extraction entirely to avoid polluting memory or wasting tokens.
  if (!isSignificantTurn(userText, botText, 0) && userText.trim().length < 60) {
    return { newAffinity: currentAffinity, newNodes: [] };
  }

  // If API key is available, use LLM to extract accurate memory node & affinity delta
  if (apiKeyConfig && apiKeyConfig.key.trim()) {
    let rawResponse = '';
    try {
      const extractionPrompt = isDialogueRu
        ? `Проанализируй данный раунд ролевого диалога между ПОЛЬЗОВАТЕЛЕМ и ПЕРСОНАЖЕМ.
1. Определи изменение расположения/симпатии персонажа к пользователю (от -10 до +10).
2. Оцени, произошло ли в этой реплике что-то ДЕЙСТВИТЕЛЬНО ВАЖНОЕ (раскрытие тайны, клятва, обещание, признание, критический факт, крупный конфликт или сближение).
КРИТИЧЕСКИ ВАЖНОЕ ПРАВИЛО ЗНАЧИМОСТИ:
- Если диалог тривиальный, повседневный, обычное приветствие, простая болтовня или мелкое действие — НЕ создавай узлов памяти (верни "nodes": []).
- Сохраняй в "nodes" ТОЛЬКО по-настоящему важные и памятные события/факты/тайны (максимум 1-2 узла).
- Поля "label" и "detail" пиши на том же языке, на котором говорят участники (русский).

ПОЛЬЗОВАТЕЛЬ: ${userText}
ПЕРСОНАЖ: ${botText}

Ответь СТРОГО в формате JSON без markdown:
{
  "affinityDelta": 0,
  "nodes": [
    {
      "label": "Краткий заголовок (2-4 слова)",
      "type": "event" | "fact" | "relationship" | "location" | "secret",
      "detail": "Одно четкое предложение с описанием важного воспоминания."
    }
  ]
}
Если ничего важного не произошло, поле "nodes" ОБЯЗАТЕЛЬНО должно быть пустым массивом: "nodes": [].
Только чистый JSON.`
        : `Analyze this roleplay dialogue turn between USER and CHARACTER.
1. Determine how user's actions affect character's affinity (-10 to +10 change).
2. Evaluate if something GENUINELY IMPORTANT occurred in this exchange (a secret revealed, an oath or promise, confession of feelings, critical lore fact, major conflict or alliance).
CRITICAL SIGNIFICANCE RULE:
- If the dialogue is routine small talk, everyday greeting, casual banter, or minor actions — DO NOT create memory nodes (return "nodes": []).
- Only add to "nodes" if the turn represents a truly memorable, plot-relevant milestone (max 1-2 nodes).
- Write "label" and "detail" strictly in the same language as the dialogue.

USER: ${userText}
CHARACTER: ${botText}

Respond STRICTLY with valid JSON:
{
  "affinityDelta": 0,
  "nodes": [
    {
      "label": "Short Title (3-5 words)",
      "type": "event" | "fact" | "relationship" | "location" | "secret",
      "detail": "One concise sentence describing the significant memory."
    }
  ]
}
If nothing important occurred, "nodes" MUST be an empty array: "nodes": [].
No markdown wrappers, raw JSON only.`;

      await streamChatCompletion({
        apiKeyConfig,
        model: model || 'deepseek/deepseek-chat',
        messages: [
          { role: 'system', content: 'You are an analytical memory module for an RPG engine.' },
          { role: 'user', content: extractionPrompt },
        ],
        temperature: 0.3,
        onToken: (tok) => {
          rawResponse += tok;
        },
        onError: () => {},
      });

      let cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
      const parsed = JSON.parse(cleaned);

      const delta = typeof parsed.affinityDelta === 'number' ? parsed.affinityDelta : 0;
      const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));

      const createdNodes: MemoryNode[] = [];
      const isSignificant = isSignificantTurn(userText, botText, delta);
      if (isSignificant && Array.isArray(parsed.nodes)) {
        for (const item of parsed.nodes) {
          if (item.label && item.detail) {
            const norm = normalizeLabel(item.label);
            const existingInChat = await db.memoryNodes.where('chatId').equals(chatId).sortBy('createdAt');
            const duplicate = existingInChat.find((n) => normalizeLabel(n.label) === norm);

            if (duplicate) {
              // Update existing node rather than creating duplicate; preserve previous turn's messageId
              const finalMessageId = duplicate.messageId || messageId;
              await db.memoryNodes.update(duplicate.id, {
                messageId: finalMessageId,
                detail: item.detail.length > duplicate.detail.length ? item.detail : duplicate.detail,
                createdAt: Date.now(),
              });
              createdNodes.push({ ...duplicate, messageId: finalMessageId, detail: item.detail });
            } else {
              const node: MemoryNode = {
                id: 'node-' + Math.random().toString(36).substring(2, 10),
                chatId,
                messageId,
                label: item.label,
                type: item.type || 'fact',
                detail: item.detail,
                createdAt: Date.now(),
              };
              await db.memoryNodes.put(node);
              createdNodes.push(node);

              // Connect to previous chronological node if any
              const updatedNodes = await db.memoryNodes.where('chatId').equals(chatId).sortBy('createdAt');
              if (updatedNodes.length > 1) {
                const prev = updatedNodes[updatedNodes.length - 2];
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
        }
      }

      await pruneAndConsolidateMemories(chatId, 30);
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

  // Enhanced conversational sentiment & bond progression check (heuristic fallback)
  let delta = 0;
  const lower = (userText + ' ' + botText).toLowerCase();

  const positiveWords = [
    'спасибо', 'благодар', 'нравиш', 'любл', 'обня', 'поцелу', 'друг', 'помогу', 'помощь',
    'вместе', 'милая', 'красив', 'умн', 'верен', 'доверя', 'береги', 'рад', 'улыб', 'смея',
    'защищ', 'рядом', 'thank', 'love', 'care', 'friend', 'help', 'trust', 'kiss', 'smile',
    'together', 'protect', 'sweet', 'cute', 'glad', 'warm',
  ];
  const negativeWords = [
    'ненавижу', 'убить', 'предател', 'мразь', 'урод', 'дурак', 'исчезни', 'пошел вон',
    'лжец', 'враг', 'удар', 'выстрел', 'угрож', 'hate', 'kill', 'traitor', 'fool', 'disappear',
    'enemy', 'liar', 'strike', 'threat', 'stupid', 'leave',
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
    delta = Math.min(6, 1 + posCount);
  } else if (negCount > posCount) {
    delta = -Math.min(8, 2 + negCount * 2);
  } else if (userText.trim().length > 15) {
    delta = 1;
  }

  const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));

  // Significance filter: only store important turns into memory
  if (!isSignificantTurn(userText, botText, delta)) {
    return { newAffinity, newNodes: [] };
  }

  // Check if label already exists
  const candidateLabel = userText.slice(0, 24) + '...';
  const norm = normalizeLabel(candidateLabel);
  const existingInChat = await db.memoryNodes.where('chatId').equals(chatId).sortBy('createdAt');
  const duplicate = existingInChat.find((n) => normalizeLabel(n.label) === norm);

  let node: MemoryNode;
  if (duplicate) {
    const finalMessageId = duplicate.messageId || messageId;
    await db.memoryNodes.update(duplicate.id, {
      messageId: finalMessageId,
      createdAt: Date.now(),
    });
    node = { ...duplicate, messageId: finalMessageId };
  } else {
    node = {
      id: 'node-' + Math.random().toString(36).substring(2, 10),
      chatId,
      messageId,
      label: candidateLabel,
      type: delta !== 0 ? 'relationship' : 'event',
      detail: isDialogueRu
        ? `Пользователь: "${userText.slice(0, 80)}" | Персонаж: "${botText.slice(0, 80)}"`
        : `User said: "${userText.slice(0, 80)}" | Character responded: "${botText.slice(0, 80)}"`,
      createdAt: Date.now(),
    };
    await db.memoryNodes.put(node);

    if (existingInChat.length > 0) {
      const prev = existingInChat[existingInChat.length - 1];
      const edge: MemoryEdge = {
        id: 'edge-' + Math.random().toString(36).substring(2, 10),
        chatId,
        source: prev.id,
        target: node.id,
        label: isDialogueRu ? 'связано с' : 'relates to',
      };
      await db.memoryEdges.put(edge);
    }
  }

  await pruneAndConsolidateMemories(chatId, 30);
  return { newAffinity, newNodes: [node] };
}
