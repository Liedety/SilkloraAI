import React, { useRef, useEffect, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, X, Info } from 'lucide-react';
import type { MemoryNode, MemoryEdge } from '../types';

interface MemoryGraphViewProps {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

interface SimNode extends MemoryNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

const TYPE_COLORS: Record<string, { bg: string; border: string; glow: string }> = {
  event: { bg: '#d97706', border: '#f59e0b', glow: 'rgba(245, 158, 11, 0.4)' },
  relationship: { bg: '#e11d48', border: '#fb7185', glow: 'rgba(244, 63, 94, 0.4)' },
  fact: { bg: '#0284c7', border: '#38bdf8', glow: 'rgba(56, 189, 248, 0.4)' },
  location: { bg: '#059669', border: '#34d399', glow: 'rgba(16, 185, 129, 0.4)' },
  secret: { bg: '#7e22ce', border: '#c084fc', glow: 'rgba(168, 85, 247, 0.4)' },
};

export const MemoryGraphView: React.FC<MemoryGraphViewProps> = ({ nodes, edges }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);

  const simNodesRef = useRef<SimNode[]>([]);
  const isDraggingRef = useRef(false);
  const dragTargetRef = useRef<SimNode | null>(null);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Dynamically update canvas dimensions on resize to prevent stretching / squashing
  useEffect(() => {
    const updateSize = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Initialize simulation positions
  useEffect(() => {
    const existingMap = new Map<string, SimNode>(simNodesRef.current.map((n) => [n.id, n]));
    const angleStep = (Math.PI * 2) / (nodes.length || 1);

    simNodesRef.current = nodes.map((node, i) => {
      const existing = existingMap.get(node.id);
      if (existing) return existing;

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
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
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
            const force = (kRepulsion / (dist * dist));
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
        if (dragTargetRef.current !== node) {
          node.vx -= node.x * kCenter;
          node.vy -= node.y * kCenter;
          node.vx *= damping;
          node.vy *= damping;
          node.x += node.vx;
          node.y += node.vy;
        }
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

      // Draw subtle grid lines
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
        }
      }

      // Draw Nodes
      for (const node of simNodes) {
        const colors = TYPE_COLORS[node.type] || TYPE_COLORS.fact;

        // Outer glow
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = colors.glow;
        ctx.fill();

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = colors.bg;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = colors.border;
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
  }, [edges, pan, zoom]);

  // Pointer interactions
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Convert screen coordinates to world coordinates
    const worldX = (clientX - canvas.width / 2 - pan.x) / zoom;
    const worldY = (clientY - canvas.height / 2 - pan.y) / zoom;

    // Check hit test on nodes
    const hit = simNodesRef.current.find((n) => {
      const dx = n.x - worldX;
      const dy = n.y - worldY;
      return Math.sqrt(dx * dx + dy * dy) <= n.radius + 5;
    });

    if (hit) {
      dragTargetRef.current = hit;
      setSelectedNode(hit);
    } else {
      dragTargetRef.current = null;
    }

    isDraggingRef.current = true;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    if (dragTargetRef.current) {
      dragTargetRef.current.x += dx / zoom;
      dragTargetRef.current.y += dy / zoom;
      dragTargetRef.current.vx = 0;
      dragTargetRef.current.vy = 0;
    } else {
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    }
  };

  const handlePointerUp = () => {
    isDraggingRef.current = false;
    dragTargetRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.4, Math.min(2.5, z * factor)));
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[360px] bg-silk-950 rounded-2xl overflow-hidden border border-silk-800 shadow-inner select-none flex flex-col"
    >
      {/* Floating View Controls */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 bg-silk-900/90 backdrop-blur-md p-1.5 rounded-xl border border-silk-700/60 shadow-lg">
        <button
          onClick={() => setZoom((z) => Math.min(2.5, z * 1.2))}
          type="button"
          className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-silk-800"
          title="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(0.4, z * 0.8))}
          type="button"
          className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-silk-800"
          title="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          type="button"
          className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-silk-800"
          title="Reset View"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-2 text-[10px] text-slate-400 bg-silk-900/80 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-silk-800">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> Event
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> Bond
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-sky-500 inline-block" /> Fact
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Place
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> Secret
        </span>
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
        <div className="absolute inset-x-3 bottom-12 z-20 bg-silk-900/95 backdrop-blur-md border border-silk-700/80 rounded-xl p-3 shadow-2xl animate-fade-in text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase text-white tracking-wider"
                style={{ backgroundColor: TYPE_COLORS[selectedNode.type]?.bg || '#0284c7' }}
              >
                {selectedNode.type}
              </span>
              <h4 className="font-semibold text-slate-200 text-sm">{selectedNode.label}</h4>
            </div>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-slate-400 hover:text-white p-0.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="mt-1.5 text-slate-300 leading-relaxed">{selectedNode.detail}</p>
        </div>
      )}
    </div>
  );
};
