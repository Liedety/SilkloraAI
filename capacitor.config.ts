import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.silklora.ai',
  appName: 'SilkloraAI',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
