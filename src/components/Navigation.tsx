import React from 'react';
import { Users, FolderGit2, Settings as SettingsIcon } from 'lucide-react';
import { translations } from '../i18n';
import type { Language } from '../types';

export type TabType = 'characters' | 'groups' | 'settings';

interface NavigationProps {
  activeTab: TabType;
  onChangeTab: (tab: TabType) => void;
  language: Language;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onChangeTab,
  language,
}) => {
  const t = translations[language];

  const items = [
    { id: 'characters' as TabType, label: t.navCharacters, icon: Users },
    { id: 'groups' as TabType, label: t.navGroups, icon: FolderGit2 },
    { id: 'settings' as TabType, label: t.navSettings, icon: SettingsIcon },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-silk-900/95 backdrop-blur-xl border-t border-silk-800/80 px-4 py-2 pb-safe">
      <div className="max-w-md mx-auto flex items-center justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChangeTab(item.id)}
              type="button"
              className={`flex flex-col items-center justify-center flex-1 py-1.5 px-2 rounded-xl transition-all duration-200 ${
                isActive
                  ? 'text-violet-400 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <div
                className={`p-1 rounded-xl transition-all ${
                  isActive ? 'bg-violet-600/20' : ''
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : 'stroke-[1.8]'}`} />
              </div>
              <span className="text-[11px] mt-0.5 tracking-tight">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
