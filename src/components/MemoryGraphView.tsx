import React, { useRef, useEffect, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, X, Network, LayoutGrid, Trash2 } from 'lucide-react';
import type { MemoryNode, MemoryEdge, Language } from '../types';
import { db } from '../db';

interface MemoryGraphViewProps {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  language?: Language;
}

interface SimNode extends MemoryNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isPinned?: boolean;
}

const TYPE_CONFIG: Record<
  string,
  { bg: string; border: string; glow: string; labelEn: string; labelRu: string }
> = {
  event: {
    bg: '#d97706',
    border: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.4)',
    labelEn: 'Event',
    labelRu: 'Событие',
  },
  relationship: {
    bg: '#e11d48',
    border: '#fb7185',
    glow: 'rgba(244, 63, 94, 0.4)',
    labelEn: 'Bond',
    labelRu: 'Связь',
  },
  fact: {
    bg: '#0284c7',
    border: '#38bdf8',
    glow: 'rgba(56, 189, 248, 0.4)',
    labelEn: 'Fact',
    labelRu: 'Факт',
  },
  location: {
    bg: '#059669',
    border: '#34d399',
    glow: 'rgba(16, 185, 129, 0.4)',
    labelEn: 'Location',
    labelRu: 'Локация',
  },
  secret: {
    bg: '#7e22ce',
    border: '#c084fc',
    glow: 'rgba(168, 85, 247, 0.4)',
    labelEn: 'Secret',
    labelRu: 'Секрет',
  },
};

const translateEdgeLabel = (label: string, isRu: boolean): string => {
  if (!isRu || !label) return label;
  const l = label.toLowerCase().trim();
  const ruMap: Record<string, string> = {
    'leads to': 'приводит к',
    'relates to': 'связано с',
    'related to': 'связано с',
    'connected to': 'связано с',
    'causes': 'вызывает',
    'caused': 'вызвало',
    'knows': 'знает',
    'trusts': 'доверяет',
    'loves': 'любит',
    'fears': 'боится',
    'hates': 'ненавидит',
    'allied with': 'в союзе с',
    'hostile to': 'враждебен к',
    'friend': 'друг',
    'enemy': 'враг',
    'bond': 'связь',
    'relationship': 'отношения',
    'secret': 'тайна',
  };
  return ruMap[l] || label;
};

export const MemoryGraphView: React.FC<MemoryGraphViewProps> = ({
  nodes,
  edges,
  language = 'en',
}) => {
  const isRu = language === 'ru';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'cards'>('graph');

  const simNodesRef = useRef<SimNode[]>([]);
  const isDraggingRef = useRef(false);
  const dragTargetRef = useRef<SimNode | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pointerDownPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);

  // Dynamically update canvas dimensions on resize using ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    };

    updateSize();

    const ro = new ResizeObserver(() => {
      updateSize();
    });
    ro.observe(container);

    window.addEventListener('resize', updateSize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [viewMode]);

  // Initialize simulation positions
  useEffect(() => {
    const existingMap = new Map<string, SimNode>(simNodesRef.current.map((n) => [n.id, n]));
    const angleStep = (Math.PI * 2) / (nodes.length || 1);

    simNodesRef.current = nodes.map((node, i) => {
      const existing = existingMap.get(node.id);
      if (existing) {
        return { ...existing, label: node.label, detail: node.detail, type: node.type };
      }

      const angle = i * angleStep;
      const distance = 80 + (i % 3) * 60;
      return {
        ...node,
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        radius: 20,
      };
    });
  }, [nodes]);

  // Main rendering & physics animation loop
  useEffect(() => {
    if (viewMode !== 'graph') return;
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      if (width <= 0 || height <= 0) {
        animId = requestAnimationFrame(render);
        return;
      }
      const centerX = width / 2;
      const centerY = height / 2;

      // Physics step
      const simNodes = simNodesRef.current;
      const kRepulsion = 1200;
      const kAttraction = 0.04;
      const kCenter = 0.015;
      const damping = 0.88;

      // Repulsion between all nodes
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
          const a = simNodes[i];
          const b = simNodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < 260) {
            const force = kRepulsion / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      // Edge spring attraction
      const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
      for (const edge of edges) {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (source && target) {
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetDist = 110;
          const delta = dist - targetDist;
          const fx = (dx / dist) * delta * kAttraction;
          const fy = (dy / dist) * delta * kAttraction;
          source.vx += fx;
          source.vy += fy;
          target.vx -= fx;
          target.vy -= fy;
        }
      }

      // Center gravity & update positions
      for (const node of simNodes) {
        if (node.isPinned || dragTargetRef.current === node) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx -= node.x * kCenter;
        node.vy -= node.y * kCenter;
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
      }

      // Drawing
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Background grid with DPR scaling
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#07090e';
      ctx.fillRect(0, 0, width, height);

      // Apply pan & zoom
      ctx.translate(centerX + pan.x, centerY + pan.y);
      ctx.scale(zoom, zoom);

      // Draw subtle grid lines with square 1:1 aspect
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      const gridSize = 50;
      for (let x = -800; x <= 800; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, -800);
        ctx.lineTo(x, 800);
        ctx.stroke();
      }
      for (let y = -800; y <= 800; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(-800, y);
        ctx.lineTo(800, y);
        ctx.stroke();
      }

      // Draw Edges
      for (const edge of edges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (s && t) {
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(t.x, t.y);
          ctx.strokeStyle = 'rgba(139, 92, 246, 0.4)';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Small midpoint marker
          const mx = (s.x + t.x) / 2;
          const my = (s.y + t.y) / 2;
          ctx.beginPath();
          ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = '#a78bfa';
          ctx.fill();

          // Localized edge label badge
          if (edge.label) {
            const edgeText = translateEdgeLabel(edge.label, isRu);
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const tm = ctx.measureText(edgeText);
            const pw = tm.width + 8;
            const ph = 14;

            ctx.fillStyle = 'rgba(12, 10, 26, 0.9)';
            ctx.fillRect(mx - pw / 2, my - ph / 2, pw, ph);
            ctx.strokeStyle = 'rgba(139, 92, 246, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(mx - pw / 2, my - ph / 2, pw, ph);

            ctx.fillStyle = '#ddd6fe';
            ctx.fillText(edgeText, mx, my);
          }
        }
      }

      // Draw Nodes
      for (const node of simNodes) {
        const conf = TYPE_CONFIG[node.type] || TYPE_CONFIG.fact;

        // Outer glow
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = conf.glow;
        ctx.fill();

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = conf.bg;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = conf.border;
        ctx.stroke();

        // Node label
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Draw text background pill for clarity
        const text = node.label.length > 22 ? node.label.slice(0, 20) + '...' : node.label;
        const textMetrics = ctx.measureText(text);
        const textWidth = textMetrics.width;

        ctx.fillStyle = 'rgba(12, 15, 23, 0.85)';
        ctx.fillRect(node.x - textWidth / 2 - 4, node.y + node.radius + 4, textWidth + 8, 16);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.strokeRect(node.x - textWidth / 2 - 4, node.y + node.radius + 4, textWidth + 8, 16);

        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(text, node.x, node.y + node.radius + 6);
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [edges, pan, zoom, viewMode]);

  // Pointer interactions with accurate CSS-to-Canvas coordinate projection
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Use CSS dimensions (rect.width & rect.height), NOT device pixels (canvas.width)
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const worldX = (clientX - centerX - pan.x) / zoom;
    const worldY = (clientY - centerY - pan.y) / zoom;

    // Hit test on nodes with comfortable touch target radius
    const hit = simNodesRef.current.find((n) => {
      const dx = n.x - worldX;
      const dy = n.y - worldY;
      const touchR = Math.max(n.radius + 14, 34);
      return Math.sqrt(dx * dx + dy * dy) <= touchR;
    });

    if (hit) {
      dragTargetRef.current = hit;
      setSelectedNode(hit);
    }

    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const dist = Math.hypot(e.clientX - pointerDownPosRef.current.x, e.clientY - pointerDownPosRef.current.y);
    if (dist > 4) {
      hasDraggedRef.current = true;
    }

    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    if (dragTargetRef.current) {
      dragTargetRef.current.isPinned = true;
      dragTargetRef.current.x += dx / zoom;
      dragTargetRef.current.y += dy / zoom;
      dragTargetRef.current.vx = 0;
      dragTargetRef.current.vy = 0;
    } else {
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (dragTargetRef.current && hasDraggedRef.current) {
      dragTargetRef.current.isPinned = true;
    }
    isDraggingRef.current = false;
    dragTargetRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.4, Math.min(2.5, z * factor)));
  };

  const handleDeleteNode = async (nodeId: string) => {
    await db.memoryNodes.delete(nodeId);
    await db.memoryEdges.where('source').equals(nodeId).delete();
    await db.memoryEdges.where('target').equals(nodeId).delete();
    if (selectedNode?.id === nodeId) {
      setSelectedNode(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* View Switcher Bar */}
      <div className="flex items-center justify-between pb-1">
        <div className="flex items-center gap-1 bg-silk-850 p-1 rounded-xl border border-silk-800">
          <button
            type="button"
            onClick={() => setViewMode('graph')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'graph'
                ? 'bg-violet-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>{isRu ? 'Граф' : 'Graph'}</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('cards')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'cards'
                ? 'bg-violet-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>{isRu ? 'Карточки' : 'Cards'}</span>
          </button>
        </div>

        <div className="text-[11px] font-mono text-slate-400 bg-silk-850 px-2.5 py-1 rounded-lg border border-silk-800">
          {nodes.length} {isRu ? 'воспоминаний' : 'items'}
        </div>
      </div>

      {viewMode === 'graph' ? (
        <div
          ref={containerRef}
          className="relative w-full h-[360px] bg-silk-950 rounded-2xl overflow-hidden border border-silk-800 shadow-inner select-none flex flex-col"
        >
          {/* Floating View Controls */}
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-silk-900/90 backdrop-blur-md p-1.5 rounded-xl border border-silk-700/60 shadow-lg">
            <button
              onClick={() => setZoom((z) => Math.min(2.5, z * 1.2))}
              type="button"
              className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-silk-800"
              title={isRu ? 'Приблизить' : 'Zoom in'}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.4, z * 0.8))}
              type="button"
              className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-silk-800"
              title={isRu ? 'Отдалить' : 'Zoom out'}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
                for (const n of simNodesRef.current) {
                  n.isPinned = false;
                }
              }}
              type="button"
              className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-silk-800"
              title={isRu ? 'Сбросить вид и позиции' : 'Reset View & Positions'}
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          {/* Localized Legend */}
          <div className="absolute bottom-3 left-3 z-10 max-w-[80%] flex flex-wrap gap-2 text-[10px] text-slate-300 bg-silk-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-silk-700/70 shadow-lg">
            {Object.entries(TYPE_CONFIG).map(([type, conf]) => (
              <span key={type} className="flex items-center gap-1.5 font-medium">
                <span
                  className="w-2 h-2 rounded-full inline-block shrink-0"
                  style={{ backgroundColor: conf.border }}
                />
                <span>{isRu ? conf.labelRu : conf.labelEn}</span>
              </span>
            ))}
          </div>

          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onWheel={handleWheel}
            className="w-full h-full cursor-grab active:cursor-grabbing touch-none block"
          />

          {/* Node Detail Sheet */}
          {selectedNode && (
            <div className="absolute inset-x-3 bottom-14 z-20 bg-silk-900/95 backdrop-blur-md border border-violet-500/40 rounded-2xl p-3.5 shadow-2xl animate-fade-in text-xs space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase text-white tracking-wider shrink-0"
                    style={{ backgroundColor: TYPE_CONFIG[selectedNode.type]?.bg || '#0284c7' }}
                  >
                    {isRu
                      ? TYPE_CONFIG[selectedNode.type]?.labelRu || selectedNode.type
                      : TYPE_CONFIG[selectedNode.type]?.labelEn || selectedNode.type}
                  </span>
                  <h4 className="font-semibold text-slate-200 text-xs sm:text-sm truncate">{selectedNode.label}</h4>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleDeleteNode(selectedNode.id)}
                    type="button"
                    className="text-slate-400 hover:text-rose-400 p-1.5 rounded-lg hover:bg-silk-800"
                    title={isRu ? 'Удалить узел' : 'Delete node'}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setSelectedNode(null)}
                    type="button"
                    className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-silk-800"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p className="text-slate-300 text-xs leading-relaxed break-words">{selectedNode.detail}</p>
              <div className="text-[10px] text-slate-500">
                {new Date(selectedNode.createdAt).toLocaleString(isRu ? 'ru-RU' : 'en-US', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Cards View for comfortable inspection without squishing */
        <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
          {nodes.length === 0 ? (
            <div className="text-center py-10 px-4 space-y-2">
              <div className="w-10 h-10 rounded-2xl bg-silk-850 border border-silk-800 mx-auto flex items-center justify-center text-slate-500">
                <Network className="w-5 h-5 text-violet-400" />
              </div>
              <p className="text-xs font-semibold text-slate-300">
                {isRu ? 'Узлы памяти пока не сформированы' : 'No memory nodes formed yet'}
              </p>
              <p className="text-[11px] text-slate-500 max-w-xs mx-auto leading-relaxed">
                {isRu
                  ? 'По мере диалога бот будет автоматически сохранять важные факты, события и отношения в этот граф.'
                  : 'As you converse, the bot will automatically extract important facts, events, and bonds here.'}
              </p>
            </div>
          ) : (
            nodes.map((node) => {
              const conf = TYPE_CONFIG[node.type] || TYPE_CONFIG.fact;
              return (
                <div
                  key={node.id}
                  className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-2 shadow-sm hover:border-silk-700 transition-all border-l-4"
                  style={{ borderLeftColor: conf.border }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="px-2 py-0.5 rounded text-[10px] font-semibold text-white uppercase tracking-wider shrink-0"
                        style={{ backgroundColor: conf.bg }}
                      >
                        {isRu ? conf.labelRu : conf.labelEn}
                      </span>
                      <h4 className="font-semibold text-xs text-white truncate">{node.label}</h4>
                    </div>
                    <button
                      onClick={() => handleDeleteNode(node.id)}
                      type="button"
                      className="text-slate-400 hover:text-rose-400 p-1 rounded hover:bg-silk-800 shrink-0"
                      title={isRu ? 'Удалить' : 'Delete'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed break-words">{node.detail}</p>
                  <span className="text-[10px] text-slate-500 block">
                    {new Date(node.createdAt).toLocaleString(isRu ? 'ru-RU' : 'en-US', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
