import { db } from '../../db/index.ts';
import type { MemoryEdge, MemoryNode } from '../../types/index.ts';
import {
  bridgeAndRemoveNodes,
  findDuplicateNodes,
  isRawDialogueFallbackNode,
  isTrivialActionNode,
  normalizeLabel,
  selectNodesToPrune,
} from './scoring.ts';
import type { StateFact } from './stateFacts.ts';

const chatMemoryLocks = new Map<string, Promise<void>>();

/**
 * Serializes memory graph reads/writes per chatId so concurrent background extractions
 * or edits can never race and overwrite or delete newly created nodes/edges.
 */
export async function withChatMemoryLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatMemoryLocks.get(chatId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current, () => current);
  chatMemoryLocks.set(chatId, chained);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (chatMemoryLocks.get(chatId) === chained) {
      chatMemoryLocks.delete(chatId);
    }
  }
}

/**
 * Removes unpinned memory nodes linked to specific message IDs (or explicit node IDs)
 * inside an atomic transaction while transitively bridging their incoming -> outgoing edges.
 */
export async function removeMemoriesWithBridge(params: {
  chatId: string;
  messageIds?: Iterable<string>;
  nodeIds?: Iterable<string>;
  respectPinned?: boolean;
}): Promise<number> {
  const { chatId, messageIds, nodeIds, respectPinned = true } = params;
  const msgSet = messageIds ? new Set(messageIds) : null;
  const nodeSet = nodeIds ? new Set(nodeIds) : null;
  if ((!msgSet || msgSet.size === 0) && (!nodeSet || nodeSet.size === 0)) return 0;

  return withChatMemoryLock(chatId, async () => {
    let removed = 0;
    await db.transaction('rw', db.memoryNodes, db.memoryEdges, async () => {
      const chatNodes = await db.memoryNodes.where('chatId').equals(chatId).toArray();
      const targetIds = chatNodes
        .filter((n) => {
          if (respectPinned && n.isPinned) return false;
          if (nodeSet && nodeSet.has(n.id)) return true;
          if (msgSet && n.messageId && msgSet.has(n.messageId)) return true;
          return false;
        })
        .map((n) => n.id);

      if (targetIds.length === 0) return;
      removed = targetIds.length;

      const chatEdges = await db.memoryEdges.where('chatId').equals(chatId).toArray();
      const bridged = bridgeAndRemoveNodes(chatNodes, chatEdges, targetIds, chatId);

      await db.memoryNodes.bulkDelete(targetIds);

      const keepEdgeIds = new Set(bridged.edges.map((e) => e.id));
      const delEdgeIds = chatEdges.filter((e) => !keepEdgeIds.has(e.id)).map((e) => e.id);
      if (delEdgeIds.length > 0) {
        await db.memoryEdges.bulkDelete(delEdgeIds);
      }
      if (bridged.edges.length > 0) {
        await db.memoryEdges.bulkPut(bridged.edges);
      }
    });
    return removed;
  });
}

/**
 * Consolidates duplicate memory nodes, cleans up trivial legacy noise, and prunes lower-priority
 * nodes while sequentially bridging edges inside a single serialized Dexie transaction.
 */
export async function pruneAndConsolidateMemories(
  chatId: string,
  maxNodes: number = 36
): Promise<{ prunedCount: number; consolidatedCount: number }> {
  return withChatMemoryLock(chatId, () => _pruneAndConsolidateUnlocked(chatId, maxNodes));
}

export async function _pruneAndConsolidateUnlocked(
  chatId: string,
  maxNodes: number = 36
): Promise<{ prunedCount: number; consolidatedCount: number }> {
  let consolidatedCount = 0;
  let prunedCount = 0;

  try {
    const allDbMessages = await db.messages.where('chatId').equals(chatId).toArray();
    const existingMsgIds = new Set(allDbMessages.map((m) => m.id));
    const maxMsgTime = allDbMessages.length > 0 ? Math.max(...allDbMessages.map((m) => m.createdAt || 0)) : 0;

    await db.transaction('rw', db.memoryNodes, db.memoryEdges, async () => {
      const initialNodes = await db.memoryNodes.where('chatId').equals(chatId).toArray();
      const initialEdges = await db.memoryEdges.where('chatId').equals(chatId).toArray();
      let workingNodes = [...initialNodes];
      let workingEdges = [...initialEdges];

      // 1. Merge duplicate labels into the best survivor while re-linking edges cleanly
      const duplicateGroups = findDuplicateNodes(workingNodes);
      const dupIdsToDelete = new Set<string>();

      for (const { survivor, duplicates } of duplicateGroups) {
        for (const dup of duplicates) {
          dupIdsToDelete.add(dup.id);
          for (const e of workingEdges) {
            if (e.target === dup.id && e.source !== survivor.id) {
              const exists = workingEdges.some(
                (x) => x.source === e.source && x.target === survivor.id && !dupIdsToDelete.has(x.source)
              );
              if (!exists) {
                workingEdges.push({
                  id: 'edge-' + Math.random().toString(36).substring(2, 10),
                  chatId,
                  source: e.source,
                  target: survivor.id,
                  label: e.label,
                });
              }
            }
            if (e.source === dup.id && e.target !== survivor.id) {
              const exists = workingEdges.some(
                (x) => x.source === survivor.id && x.target === e.target && !dupIdsToDelete.has(x.target)
              );
              if (!exists) {
                workingEdges.push({
                  id: 'edge-' + Math.random().toString(36).substring(2, 10),
                  chatId,
                  source: survivor.id,
                  target: e.target,
                  label: e.label,
                });
              }
            }
          }
          consolidatedCount++;
        }
      }

      if (dupIdsToDelete.size > 0) {
        workingNodes = workingNodes.filter((n) => !dupIdsToDelete.has(n.id));
        const validIds = new Set(workingNodes.map((n) => n.id));
        workingEdges = workingEdges.filter(
          (e) => validIds.has(e.source) && validIds.has(e.target) && e.source !== e.target
        );
      }

      // 2. Remove unpinned trivial gesture/action spam or raw quote fallbacks, bridging edges sequentially
      const noiseIds: string[] = [];
      for (const node of workingNodes) {
        if (!node.isPinned && (isRawDialogueFallbackNode(node) || isTrivialActionNode(node))) {
          noiseIds.push(node.id);
        }
      }

      // 3. Only remove message-linked nodes if messages exist AND the node belongs to a tail turn that was deleted
      if (allDbMessages.length > 0) {
        for (const node of workingNodes) {
          if (
            !node.isPinned &&
            node.messageId &&
            !existingMsgIds.has(node.messageId) &&
            node.createdAt >= maxMsgTime
          ) {
            noiseIds.push(node.id);
          }
        }
      }

      if (noiseIds.length > 0) {
        const cleaned = bridgeAndRemoveNodes(workingNodes, workingEdges, noiseIds, chatId);
        prunedCount += workingNodes.length - cleaned.nodes.length;
        workingNodes = cleaned.nodes;
        workingEdges = cleaned.edges;
      }

      // 4. Prune excess lowest-priority nodes sequentially so chains (A -> B -> C -> D) bridge into (A -> D)
      if (workingNodes.length > maxNodes) {
        const toPrune = selectNodesToPrune(workingNodes, workingEdges, maxNodes);
        const pruneIds = toPrune.map((n) => n.id);
        const bridged = bridgeAndRemoveNodes(workingNodes, workingEdges, pruneIds, chatId);
        prunedCount += workingNodes.length - bridged.nodes.length;
        workingNodes = bridged.nodes;
        workingEdges = bridged.edges;
      }

      // 5. Deduplicate parallel edges (same source -> target) and drop any dangling endpoints
      const keepNodeIds = new Set(workingNodes.map((n) => n.id));
      const uniqueEdges: MemoryEdge[] = [];
      const seenPairs = new Set<string>();
      for (const e of workingEdges) {
        if (!keepNodeIds.has(e.source) || !keepNodeIds.has(e.target) || e.source === e.target) continue;
        const pairKey = `${e.source}->${e.target}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        uniqueEdges.push(e);
      }

      const delNodeIds = initialNodes.filter((n) => !keepNodeIds.has(n.id)).map((n) => n.id);
      if (delNodeIds.length > 0) {
        await db.memoryNodes.bulkDelete(delNodeIds);
      }

      const keepEdgeIds = new Set(uniqueEdges.map((e) => e.id));
      const delEdgeIds = initialEdges.filter((e) => !keepEdgeIds.has(e.id)).map((e) => e.id);
      if (delEdgeIds.length > 0) {
        await db.memoryEdges.bulkDelete(delEdgeIds);
      }
      if (uniqueEdges.length > 0) {
        await db.memoryEdges.bulkPut(uniqueEdges);
      }
    });
  } catch (err) {
    console.warn('Memory pruning/consolidation error:', err);
  }

  return { prunedCount, consolidatedCount };
}

/**
 * Legacy state-fact helper retained for compatibility; filters out routine poses/gestures
 * so ordinary movements never pollute `db.memoryNodes`.
 */
export async function saveStateFacts(chatId: string, messageId: string | undefined, facts: StateFact[]): Promise<void> {
  const meaningful = facts.filter(
    (f) => f.kind !== 'pose' && !isTrivialActionNode({ label: f.label, detail: f.detail, type: 'fact' })
  );
  if (meaningful.length === 0) return;
  await withChatMemoryLock(chatId, async () => {
    await db.transaction('rw', db.memoryNodes, db.memoryEdges, async () => {
      const existing = await db.memoryNodes.where('chatId').equals(chatId).toArray();
      const known = new Set(existing.map((n) => normalizeLabel(n.label)));
      let prev = [...existing].sort((a, b) => a.createdAt - b.createdAt).pop();
      for (const fact of meaningful) {
        const norm = normalizeLabel(fact.label);
        if (known.has(norm)) continue;
        known.add(norm);
        const node: MemoryNode = {
          id: 'node-' + Math.random().toString(36).substring(2, 10),
          chatId,
          messageId,
          label: fact.label,
          type: 'fact',
          detail: fact.detail,
          createdAt: Date.now(),
        };
        await db.memoryNodes.put(node);
        if (prev) {
          await db.memoryEdges.put({
            id: 'edge-' + Math.random().toString(36).substring(2, 10),
            chatId,
            source: prev.id,
            target: node.id,
            label: 'relates to',
          });
        }
        prev = node;
      }
    });
  });
}
