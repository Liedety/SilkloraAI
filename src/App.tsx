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

  const handleSave = async () => {
    if (saveAction) {
      await saveAction();
    }
    setIsDirty(false);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden bg-silk-950 text-slate-100 font-sans select-none">
      {/* Active Screen */}
      <main className="flex-1 w-full h-full overflow-hidden">
        {activeChat ? (
          <ChatView
            type={activeChat.type}
            targetId={activeChat.targetId}
            language={language}
            onBack={() => setActiveChat(null)}
          />
        ) : (
          <>
            {activeTab === 'characters' && (
              <CharactersView
                language={language}
                onOpenChat={(charId) => setActiveChat({ type: 'character', targetId: charId })}
                onDirtyChange={handleDirtyChange}
              />
            )}
            {activeTab === 'groups' && (
              <GroupsView
                language={language}
                onOpenGroupChat={(grpId) => setActiveChat({ type: 'group', targetId: grpId })}
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
