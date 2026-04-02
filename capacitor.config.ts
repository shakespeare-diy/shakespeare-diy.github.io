import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'diy.shakespeare.app',
  appName: 'Shakespeare',
  webDir: 'dist',
  server: {
    // Handle deep links from your domain
    hostname: 'shakespeare.diy',
    androidScheme: 'https',
    iosScheme: 'https'
  },
  android: {
    // Enable safe area handling for notches and navigation bars
    allowMixedContent: false,
    backgroundColor: '#2b0037'
  },
  ios: {
    backgroundColor: '#2b0037',
    contentInset: 'automatic',
    scheme: 'Shakespeare'
  }
};

export default config;
