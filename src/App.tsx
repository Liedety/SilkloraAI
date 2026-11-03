import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, initDatabaseDefaults } from './db';
import type { Language } from './types';
import { Navigation, type TabType } from './components/Navigation';
import { FloatingSaveButton } from './components/FloatingSaveButton';
import { CharactersView } from './views/CharactersView';
import { GroupsView } from './views/GroupsView';
import { SettingsView } from './views/SettingsView';
import { ChatView } from './views/ChatView';

function hexToRgb(hex: string): string {
  const clean = hex.replace('#', '').trim();
  let r = 139, g = 92, b = 246;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16) || 139;
    g = parseInt(clean[1] + clean[1], 16) || 92;
    b = parseInt(clean[2] + clean[2], 16) || 246;
  } else if (clean.length >= 6) {
    r = parseInt(clean.substring(0, 2), 16) || 139;
    g = parseInt(clean.substring(2, 4), 16) || 92;
    b = parseInt(clean.substring(4, 6), 16) || 246;
  }
  return `${r}, ${g}, ${b}`;
}

function adjustBrightness(hex: string, percent: number): string {
  const clean = hex.replace('#', '').trim();
  let r = 139, g = 92, b = 246;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16) || 139;
    g = parseInt(clean[1] + clean[1], 16) || 92;
    b = parseInt(clean[2] + clean[2], 16) || 246;
  } else if (clean.length >= 6) {
    r = parseInt(clean.substring(0, 2), 16) || 139;
    g = parseInt(clean.substring(2, 4), 16) || 92;
    b = parseInt(clean.substring(4, 6), 16) || 246;
  }
  const factor = 1 + percent / 100;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const add = percent > 0 ? percent * 0.4 : 0;
  const newR = clamp(r * factor + add);
  const newG = clamp(g * factor + add);
  const newB = clamp(b * factor + add);
  return `#${((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1)}`;
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('characters');
  const [activeChat, setActiveChat] = useState<{
    type: 'character' | 'group';
    targetId: string;
  } | null>(null);

  // Floating save button state
  const [isDirty, setIsDirty] = useState(false);
  const [saveAction, setSaveAction] = useState<(() => Promise<void>) | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  // Settings query
  const settings = useLiveQuery(() => db.settings.get('default'));
  const language: Language = settings?.language || 'en';

  useEffect(() => {
    initDatabaseDefaults();
  }, []);

  // Dynamically update CSS variables when theme changes
  useEffect(() => {
    if (settings?.theme) {
      const root = document.documentElement;
      const accent = settings.theme.accentColor || '#8b5cf6';
      const action = settings.theme.actionColor || '#fb7185';
      const bg = settings.theme.appBgColor || '#0a0814';
      const surface = settings.theme.appSurfaceColor || '#141126';

      const accentHover = adjustBrightness(accent, 15);
      const accentLight = adjustBrightness(accent, 40);
      const surfaceElevated = adjustBrightness(surface, 15);
      const border = adjustBrightness(surface, 25);
      const borderSubtle = adjustBrightness(surface, 35);

      root.style.setProperty('--theme-accent', accent);
      root.style.setProperty('--theme-accent-rgb', hexToRgb(accent));
      root.style.setProperty('--theme-accent-hover', accentHover);
      root.style.setProperty('--theme-accent-hover-rgb', hexToRgb(accentHover));
      root.style.setProperty('--theme-accent-light', accentLight);
      root.style.setProperty('--theme-accent-light-rgb', hexToRgb(accentLight));

      root.style.setProperty('--theme-action', action);
      root.style.setProperty('--theme-action-rgb', hexToRgb(action));

      root.style.setProperty('--app-bg', bg);
      root.style.setProperty('--app-bg-rgb', hexToRgb(bg));
      root.style.setProperty('--app-surface', surface);
      root.style.setProperty('--app-surface-rgb', hexToRgb(surface));
      root.style.setProperty('--app-surface-elevated', surfaceElevated);
      root.style.setProperty('--app-surface-elevated-rgb', hexToRgb(surfaceElevated));
      root.style.setProperty('--app-border', border);
      root.style.setProperty('--app-border-rgb', hexToRgb(border));
      root.style.setProperty('--app-border-subtle', borderSubtle);
      root.style.setProperty('--app-border-subtle-rgb', hexToRgb(borderSubtle));

      const metaThemeColor = document.querySelector('meta[name="theme-color"]');
      if (metaThemeColor) {
        metaThemeColor.setAttribute('content', bg);
      }

      const fontFamily =
        settings.theme.fontFamily === 'serif'
          ? 'Georgia, Cambria, "Times New Roman", serif'
          : settings.theme.fontFamily === 'mono'
          ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
          : 'inherit';
      root.style.setProperty('--chat-font-family', fontFamily);
    }
  }, [settings?.theme]);

  const handleLanguageChange = async (newLang: Language) => {
    await db.settings.update('default', { language: newLang });
  };

  const handleDirtyChange = (dirty: boolean, action?: () => Promise<void>) => {
    setIsDirty(dirty);
    if (action) {
      setSaveAction(() => action);
    } else if (!dirty) {
      setSaveAction(null);
    }
  };

  const handleTabChange = (tab: TabType) => {
    setIsDirty(false);
    setSaveAction(null);
    setActiveTab(tab);
  };

  const handleOpenChat = (chat: { type: 'character' | 'group'; targetId: string }) => {
    setIsDirty(false);
    setSaveAction(null);
    setActiveChat(chat);
  };

  const handleBackFromChat = () => {
    setIsDirty(false);
    setSaveAction(null);
    setActiveChat(null);
  };

  const handleSave = async () => {
    if (saveAction) {
      await saveAction();
    }
    setIsDirty(false);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden app-bg text-slate-100 font-sans select-none">
      {/* Active Screen */}
      <main className="flex-1 w-full h-full overflow-hidden">
        {activeChat ? (
          <ChatView
            type={activeChat.type}
            targetId={activeChat.targetId}
            language={language}
            onBack={handleBackFromChat}
          />
        ) : (
          <>
            {activeTab === 'characters' && (
              <CharactersView
                language={language}
                onOpenChat={(charId) => handleOpenChat({ type: 'character', targetId: charId })}
                onDirtyChange={handleDirtyChange}
              />
            )}
            {activeTab === 'groups' && (
              <GroupsView
                language={language}
                onOpenGroupChat={(grpId) => handleOpenChat({ type: 'group', targetId: grpId })}
                onDirtyChange={handleDirtyChange}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsView
                language={language}
                onLanguageChange={handleLanguageChange}
                onDirtyChange={handleDirtyChange}
              />
            )}
          </>
        )}
      </main>

      {/* Floating Save Button */}
      <FloatingSaveButton
        visible={isDirty && !activeChat}
        onSave={handleSave}
        saved={isSaved}
        label={language === 'ru' ? 'Сохранить' : 'Save'}
        savedLabel={language === 'ru' ? 'Сохранено!' : 'Saved!'}
        accentColor={settings?.theme?.accentColor}
      />

      {/* Bottom Navigation (Hidden while in active chat) */}
      {!activeChat && (
        <Navigation
          activeTab={activeTab}
          onChangeTab={handleTabChange}
          language={language}
        />
      )}
    </div>
  );
};

export default App;
