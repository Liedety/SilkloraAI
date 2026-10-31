import React, { useState, useRef, useEffect } from 'react';
import { ZoomIn, ZoomOut, Check, X, RotateCcw } from 'lucide-react';
import type { ImageCropOffset, Language } from '../types';

interface ImageCropperModalProps {
  isOpen: boolean;
  imageSrc: string;
  isAvatar?: boolean;
  initialOffset?: ImageCropOffset;
  title?: string;
  language?: Language;
  onConfirm: (croppedDataUrl: string, offset: ImageCropOffset) => void;
  onClose: () => void;
}

export const ImageCropperModal: React.FC<ImageCropperModalProps> = ({
  isOpen,
  imageSrc,
  isAvatar = true,
  initialOffset,
  title,
  language = 'en',
  onConfirm,
  onClose,
}) => {
  const isRu = language === 'ru';
  const defaultTitle = isRu ? (isAvatar ? 'Настройка аватара' : 'Настройка фона') : (isAvatar ? 'Position Avatar' : 'Position Background');
  const modalTitle = title || defaultTitle;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scale, setScale] = useState<number>(initialOffset?.scale || 1);
  const [position, setPosition] = useState<{ x: number; y: number }>({
    x: initialOffset?.x || 0,
    y: initialOffset?.y || 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [imageObj, setImageObj] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!imageSrc || !isOpen) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSrc;
    img.onload = () => {
      setImageObj(img);
    };
  }, [imageSrc, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setScale(initialOffset?.scale || 1);
      setPosition({
        x: initialOffset?.x || 0,
        y: initialOffset?.y || 0,
      });
    }
  }, [isOpen, initialOffset]);

  useEffect(() => {
    if (!imageObj || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // Draw background grid
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    // Center transformations
    ctx.translate(width / 2 + position.x, height / 2 + position.y);
    ctx.scale(scale, scale);

    // Calculate aspect ratio fitting
    const imgAspect = imageObj.width / imageObj.height;
    const targetAspect = width / height;
    let drawWidth = width;
    let drawHeight = height;

    if (imgAspect > targetAspect) {
      drawHeight = height;
      drawWidth = height * imgAspect;
    } else {
      drawWidth = width;
      drawHeight = width / imgAspect;
    }

    ctx.drawImage(imageObj, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();

    // Overlay guide mask
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';

    if (isAvatar) {
      // Circular hole mask
      const radius = Math.min(width, height) * 0.42;
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2, true);
      ctx.fill();

      // Border circle
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'var(--theme-accent, #8b5cf6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      // Rectangular border
      ctx.strokeStyle = 'var(--theme-accent, #8b5cf6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(10, 10, width - 20, height - 20);
    }
    ctx.restore();
  }, [imageObj, scale, position, isAvatar]);

  const handlePointerDown = (e: React.PointerEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handlePointerUp = () => {
    setIsDragging(false);
  };

  const handleApply = () => {
    if (!imageObj) return;

    // Create an export canvas
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = isAvatar ? 512 : 1080;
    exportCanvas.height = isAvatar ? 512 : 1920;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return;

    const width = exportCanvas.width;
    const height = exportCanvas.height;

    // Apply scale & translated position scaled up
    const displaySize = 340; // canvas display width
    const ratio = width / displaySize;

    ctx.translate(width / 2 + position.x * ratio, height / 2 + position.y * ratio);
    ctx.scale(scale, scale);

    const imgAspect = imageObj.width / imageObj.height;
    const targetAspect = width / height;
    let drawWidth = width;
    let drawHeight = height;

    if (imgAspect > targetAspect) {
      drawHeight = height;
      drawWidth = height * imgAspect;
    } else {
      drawWidth = width;
      drawHeight = width / imgAspect;
    }

    ctx.drawImage(imageObj, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

    const croppedDataUrl = exportCanvas.toDataURL('image/jpeg', 0.88);
    onConfirm(croppedDataUrl, { x: position.x, y: position.y, scale });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-sm bg-silk-900 border border-silk-700/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-silk-800">
          <h3 className="font-semibold text-sm text-slate-200">{modalTitle}</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-silk-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewport Canvas */}
        <div className="p-4 flex flex-col items-center select-none">
          <canvas
            ref={canvasRef}
            width={340}
            height={isAvatar ? 340 : 420}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className="rounded-xl cursor-grab active:cursor-grabbing touch-none border border-silk-800 shadow-inner"
          />
          <p className="text-xs text-slate-500 mt-2 text-center">
            {isRu ? 'Перетаскивайте для сдвига, ползунок ниже — масштаб' : 'Drag to pan, use slider below to zoom'}
          </p>
        </div>

        {/* Controls */}
        <div className="px-5 py-2 border-t border-silk-800/80 space-y-3">
          <div className="flex items-center gap-3">
            <ZoomOut className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={scale}
              onChange={(e) => setScale(parseFloat(e.target.value))}
              className="w-full accent-violet-500 h-1.5 bg-silk-700 rounded-lg cursor-pointer"
            />
            <ZoomIn className="w-4 h-4 text-slate-400 shrink-0" />
          </div>

          <div className="flex justify-between items-center pt-1 pb-1">
            <button
              onClick={() => {
                setPosition({ x: 0, y: 0 });
                setScale(1);
              }}
              type="button"
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white py-1.5 px-2.5 rounded-lg hover:bg-silk-800"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{isRu ? 'Сброс' : 'Reset'}</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                type="button"
                className="px-3 py-1.5 text-xs font-medium text-slate-300 rounded-lg hover:bg-silk-800"
              >
                {isRu ? 'Отмена' : 'Cancel'}
              </button>
              <button
                onClick={handleApply}
                type="button"
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white rounded-lg shadow-md theme-accent-bg"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{isRu ? 'Готово' : 'Done'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
