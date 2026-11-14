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
      className="fixed bottom-20 right-5 z-40 flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm tracking-tight transition-colors active:scale-95 border animate-fade-in"
      style={{
        backgroundColor: saved ? '#1f5138' : accentColor,
        borderColor: saved ? '#2d7250' : 'rgba(255, 255, 255, 0.14)',
        color: saved ? '#f4f4f5' : 'var(--theme-on-accent, #f4f4f5)',
      }}
    >
      {saved ? (
        <>
          <Check className="w-4 h-4" />
          <span>{savedLabel}</span>
        </>
      ) : (
        <>
          <Save className="w-4 h-4" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
};
