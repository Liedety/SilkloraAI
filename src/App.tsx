import React, { useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, DEFAULT_THEME, initDatabaseDefaults } from './db';
import type { Language } from './types';
import { Navigation, type TabType } from './components/Navigation';
import { FloatingSaveButton } from './components/FloatingSaveButton';
import { CharactersView } from './views/CharactersView';
import { GroupsView } from './views/GroupsView';
import { SettingsView } from './views/SettingsView';
import { ChatView } from './views/ChatView';
import {
  applyThemeToDocument,
  readCachedTheme,
  resolveActiveTheme,
  saveCachedTheme,
} from './utils/themePersistence';

interface SavedChatRef {
  type: 'character' | 'group';
  targetId: string;
}

export const App: React.FC = () => {
  // The app always opens on the characters list; each chat reopens its own last session
  const [activeTab, setActiveTab] = useState<TabType>('characters');
  const [activeChat, setActiveChat] = useState<SavedChatRef | null>(null);

  // Floating save button state
  const [isDirty, setIsDirty] = useState(false);
  const [saveAction, setSaveAction] = useState<(() => Promise<void>) | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  // Settings query + synchronous cached fallback so chat entry never resets message appearance
  const settings = useLiveQuery(() => db.settings.get('default'));
  const cachedThemeOnMount = useMemo(() => readCachedTheme(undefined, DEFAULT_THEME), []);
  const resolvedTheme = useMemo(
    () =>
      resolveActiveTheme({
        dbTheme: settings?.theme,
        cachedTheme: cachedThemeOnMount,
        fallback: DEFAULT_THEME,
      }),
    [settings?.theme, cachedThemeOnMount]
  );
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

  // Apply theme CSS variables synchronously before paint and keep localStorage cache warm
  useLayoutEffect(() => {
    applyThemeToDocument(resolvedTheme);
    if (settings?.theme) {
      saveCachedTheme(resolvedTheme, undefined, DEFAULT_THEME);
    }
  }, [resolvedTheme, settings?.theme]);

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
              theme={resolvedTheme}
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
