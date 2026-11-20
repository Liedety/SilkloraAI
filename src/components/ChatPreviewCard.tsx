import React from 'react';
import type { Language, ThemeConfig } from '../types';
import { hexToRgba, lineHeightNumeric } from '../utils/themePersistence';

interface ChatPreviewCardProps {
  theme: ThemeConfig;
  language?: Language;
}

export const ChatPreviewCard: React.FC<ChatPreviewCardProps> = ({ theme, language = 'en' }) => {
  const isRu = language === 'ru';

  const formatText = (text: string) => {
    const parts = text.split(/(\*[^*]+\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('*') && part.endsWith('*')) {
        return (
          <span
            key={i}
            className="italic font-normal"
            style={{ color: theme.actionColor || '#a1a1aa' }}
          >
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  // The selected font applies to the whole app, so message text simply inherits it
  const fontFamilyStyle = 'inherit';
  const lineHeightStyle = lineHeightNumeric(theme.lineHeight);

  return (
    <div
      className="relative w-full rounded-2xl overflow-hidden border border-silk-700 p-3.5 select-none"
      style={{
        backgroundColor: theme.appBgColor || '#09090b',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          {isRu ? 'Превью чата' : 'Live Chat Preview'}
        </span>
        <span className="text-[10px] font-mono text-slate-500">
          {theme.fontSize}px · {theme.bubbleRadius}px
        </span>
      </div>

      <div className="space-y-2.5" style={{ fontSize: `${theme.fontSize}px`, fontFamily: fontFamilyStyle }}>
        {/* User Message */}
        <div className="flex justify-end">
          <div
            className="max-w-[85%] px-3.5 py-2.5 text-slate-100 border border-white/10"
            style={{
              backgroundColor: hexToRgba(theme.bubbleUserBg, theme.bubbleOpacity),
              borderRadius: `${theme.bubbleRadius}px`,
            }}
          >
            <p style={{ lineHeight: lineHeightStyle }}>
              {formatText(
                isRu
                  ? '*Проверяю замок старой двери.* Здесь безопасно?'
                  : '*Checks the heavy brass lock.* Is it safe inside?'
              )}
            </p>
          </div>
        </div>

        {/* Bot Message */}
        <div className="flex justify-start">
          <div
            className="max-w-[85%] px-3.5 py-2.5 text-slate-100 border border-white/10"
            style={{
              backgroundColor: hexToRgba(theme.bubbleBotBg, theme.bubbleOpacity),
              borderRadius: `${theme.bubbleRadius}px`,
            }}
          >
            <div className="text-[10px] font-semibold mb-1" style={{ color: theme.actionColor || '#a1a1aa' }}>
              {isRu ? 'Эвелин' : 'Evelyn'}
            </div>
            <p style={{ lineHeight: lineHeightStyle }}>
              {formatText(
                isRu
                  ? '*Отступает в сторону и гасит фонарь.* Относительно. Входи быстрее, пока дождь не усилился.'
                  : '*Steps back and dims the lantern.* Safe enough. Come in before the rain picks up.'
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
