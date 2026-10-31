import React from 'react';
import { Save, Check } from 'lucide-react';

interface FloatingSaveButtonProps {
  visible: boolean;
  onSave: () => void;
  saved?: boolean;
  label?: string;
}

export const FloatingSaveButton: React.FC<FloatingSaveButtonProps> = ({
  visible,
  onSave,
  saved = false,
  label = 'Save',
}) => {
  if (!visible) return null;

  return (
    <button
      onClick={onSave}
      type="button"
      className="fixed bottom-20 right-5 z-40 flex items-center gap-2 px-5 py-3 rounded-full shadow-2xl font-medium text-sm tracking-wide text-white transition-all transform active:scale-95 duration-200 border border-white/20"
      style={{
        background: saved
          ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)'
          : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
        boxShadow: '0 10px 25px -5px rgba(99, 102, 241, 0.5)',
      }}
    >
      {saved ? (
        <>
          <Check className="w-4 h-4 text-white" />
          <span>Saved!</span>
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
