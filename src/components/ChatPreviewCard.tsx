import React from 'react';
import type { ThemeConfig } from '../types';

interface ChatPreviewCardProps {
  theme: ThemeConfig;
}

export const ChatPreviewCard: React.FC<ChatPreviewCardProps> = ({ theme }) => {
  const formatText = (text: string) => {
    // Replace *action* with colored span
    const parts = text.split(/(\*[^*]+\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('*') && part.endsWith('*')) {
        return (
          <span
            key={i}
            className="italic font-normal"
            style={{ color: theme.actionColor || '#fb7185' }}
          >
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  const fontFamilyStyle =
    theme.fontFamily === 'serif'
      ? 'Georgia, Cambria, "Times New Roman", serif'
      : theme.fontFamily === 'mono'
      ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      : 'inherit';

  const lineHeightStyle =
    theme.lineHeight === 'loose'
      ? 1.8
      : theme.lineHeight === 'relaxed'
      ? 1.6
      : 1.45;

  return (
    <div
      className="relative w-full rounded-2xl overflow-hidden border border-silk-700/80 p-4 shadow-xl select-none"
      style={{
        backgroundColor: `rgba(var(--app-bg-rgb, 10, 14, 23), ${theme.backgroundTint})`,
      }}
    >
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">
        Live Chat Preview
      </div>

      <div className="space-y-3" style={{ fontSize: `${theme.fontSize}px`, fontFamily: fontFamilyStyle }}>
        {/* User Message */}
        <div className="flex justify-end">
          <div
            className="max-w-[85%] px-3.5 py-2.5 text-slate-100 shadow-md backdrop-blur-sm"
            style={{
              backgroundColor: theme.bubbleUserBg,
              borderRadius: `${theme.bubbleRadius}px`,
              opacity: theme.bubbleOpacity,
            }}
          >
            <p style={{ lineHeight: lineHeightStyle }}>
              {formatText('*Gently touches the ancient tome* We should proceed with caution.')}
            </p>
          </div>
        </div>

        {/* Bot Message */}
        <div className="flex justify-start">
          <div
            className="max-w-[85%] px-3.5 py-2.5 text-slate-100 shadow-md backdrop-blur-sm"
            style={{
              backgroundColor: theme.bubbleBotBg,
              borderRadius: `${theme.bubbleRadius}px`,
              opacity: theme.bubbleOpacity,
            }}
          >
            <div className="text-[10px] text-violet-400 font-semibold mb-1">Evelyn Vance</div>
            <p style={{ lineHeight: lineHeightStyle }}>
              {formatText(
                '*Leans closer, her eyes flashing with curiosity.* Caution is a luxury we lost the moment we stepped into this archive.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
