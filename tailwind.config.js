/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        silk: {
          950: 'rgba(var(--app-bg-rgb, 7, 9, 14), <alpha-value>)',
          900: 'rgba(var(--app-surface-rgb, 12, 15, 23), <alpha-value>)',
          850: 'rgba(var(--app-surface-elevated-rgb, 17, 21, 32), <alpha-value>)',
          800: 'rgba(var(--app-border-rgb, 22, 27, 42), <alpha-value>)',
          700: 'rgba(var(--app-border-subtle-rgb, 32, 39, 60), <alpha-value>)',
          600: 'rgba(var(--app-border-subtle-rgb, 45, 55, 82), <alpha-value>)',
          500: '#485579',
          400: '#7c8ba1',
          300: '#adb8cb',
          200: '#dce2ee',
          100: '#f1f4fa',
        },
        violet: {
          50: 'rgba(var(--theme-accent-rgb, 139, 92, 246), 0.1)',
          100: 'rgba(var(--theme-accent-rgb, 139, 92, 246), 0.15)',
          200: 'rgba(var(--theme-accent-rgb, 139, 92, 246), 0.3)',
          300: 'rgba(var(--theme-accent-light-rgb, 196, 181, 253), <alpha-value>)',
          400: 'rgba(var(--theme-accent-light-rgb, 167, 139, 250), <alpha-value>)',
          500: 'rgba(var(--theme-accent-hover-rgb, 124, 58, 237), <alpha-value>)',
          600: 'rgba(var(--theme-accent-rgb, 139, 92, 246), <alpha-value>)',
          700: 'rgba(var(--theme-accent-hover-rgb, 124, 58, 237), <alpha-value>)',
          800: 'rgba(var(--theme-accent-rgb, 139, 92, 246), 0.8)',
          900: 'rgba(var(--theme-accent-rgb, 139, 92, 246), 0.4)',
          950: 'rgba(var(--theme-accent-rgb, 139, 92, 246), 0.25)',
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
