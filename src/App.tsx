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
import { fontStack } from './utils/fonts';

interface SavedChatRef {
  type: 'character' | 'group';
  targetId: string;
}

function parseHexColor(hex: string, fallback: [number, number, number] = [82, 82, 91]): [number, number, number] {
  const clean = (hex || '').replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b];
  } else if (clean.length >= 6) {
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b];
  }
  return fallback;
}

function hexToRgb(hex: string): string {
  const [r, g, b] = parseHexColor(hex);
  return `${r}, ${g}, ${b}`;
}

function adjustBrightness(hex: string, percent: number): string {
  const [r, g, b] = parseHexColor(hex);
  const factor = 1 + percent / 100;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  // Ensure pure-black OLED substrates (#000000 / #08080a) still gain visible 1px border steps
  const add = percent > 0 ? percent * 0.45 : 0;
  const newR = clamp(r * factor + add);
  const newG = clamp(g * factor + add);
  const newB = clamp(b * factor + add);
  return `#${((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1)}`;
}

function contrastTextColor(hex: string): string {
  const [r, g, b] = parseHexColor(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#09090b' : '#f4f4f5';
}

export const App: React.FC = () => {
  // The app always opens on the characters list; each chat reopens its own last session
  const [activeTab, setActiveTab] = useState<TabType>('characters');
  const [activeChat, setActiveChat] = useState<SavedChatRef | null>(null);

  // Floating save button state
  const [isDirty, setIsDirty] = useState(false);
  const [saveAction, setSaveAction] = useState<(() => Promise<void>) | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  // Settings query
  const settings = useLiveQuery(() => db.settings.get('default'));
  const language: Language = settings?.language || 'en';

  useEffect(() => {
    (async () => {
      await initDatabaseDefaults();
      // Ask the system not to evict local data (settings, chats, theme) under storage pressure
      try {
        await navigator.storage?.persist?.();
      } catch {
        // not supported
      }
    })();
  }, []);

  // Dynamically update CSS variables when theme changes
  useEffect(() => {
    if (settings?.theme) {
      const root = document.documentElement;
      const accent = settings.theme.accentColor || '#52525b';
      const action = settings.theme.actionColor || '#a1a1aa';
      const bg = settings.theme.appBgColor || '#09090b';
      const surface = settings.theme.appSurfaceColor || '#111114';

      const accentHover = adjustBrightness(accent, 15);
      const accentLight = adjustBrightness(accent, 42);
      const surfaceElevated = adjustBrightness(surface, 14);
      const border = adjustBrightness(surface, 26);
      const borderSubtle = adjustBrightness(surface, 38);

      root.style.setProperty('--theme-accent', accent);
      root.style.setProperty('--theme-accent-rgb', hexToRgb(accent));
      root.style.setProperty('--theme-on-accent', contrastTextColor(accent));
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

      const fontChoice = settings.theme.fontFamily || 'sans';
      root.style.setProperty('--app-font', fontStack(fontChoice));
      root.style.setProperty('--chat-font-family', 'inherit');
      root.setAttribute('data-font', fontChoice);
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

  const handleOpenChat = (chat: SavedChatRef) => {
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
          <div key={`chat-${activeChat.type}-${activeChat.targetId}`} className="w-full h-full animate-chat-in">
            <ChatView
              type={activeChat.type}
              targetId={activeChat.targetId}
              language={language}
              onBack={handleBackFromChat}
            />
          </div>
        ) : (
          <div key={`tab-${activeTab}`} className="w-full h-full animate-view-in">
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
          </div>
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
