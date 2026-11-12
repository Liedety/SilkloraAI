import React from 'react';
import { Save, Check } from 'lucide-react';

interface FloatingSaveButtonProps {
  visible: boolean;
  onSave: () => void;
  saved?: boolean;
  label?: string;
  savedLabel?: string;
  accentColor?: string;
}

export const FloatingSaveButton: React.FC<FloatingSaveButtonProps> = ({
  visible,
  onSave,
  saved = false,
  label = 'Save',
  savedLabel = 'Saved!',
  accentColor = '#8b5cf6',
}) => {
  if (!visible) return null;

  return (
    <button
      onClick={onSave}
      type="button"
      className="fixed bottom-20 right-5 z-40 flex items-center gap-2 px-5 py-3 rounded-full shadow-2xl font-medium text-sm tracking-wide text-white transition-all transform active:scale-95 duration-200 border border-white/20 animate-fade-in"
      style={{
        background: saved
          ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)'
          : `linear-gradient(135deg, ${accentColor} 0%, rgba(var(--app-surface-rgb, 49, 46, 129), 0.95) 100%)`,
        boxShadow: `0 10px 25px -5px ${accentColor}80`,
      }}
    >
      {saved ? (
        <>
          <Check className="w-4 h-4 text-white" />
          <span>{savedLabel}</span>
        </>
      ) : (
        <>
          <Save className="w-4 h-4 text-white" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
};
