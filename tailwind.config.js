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
          950: 'rgba(var(--app-bg-rgb, 9, 9, 11), <alpha-value>)',
          900: 'rgba(var(--app-surface-rgb, 17, 17, 20), <alpha-value>)',
          850: 'rgba(var(--app-surface-elevated-rgb, 24, 24, 28), <alpha-value>)',
          800: 'rgba(var(--app-border-rgb, 36, 36, 42), <alpha-value>)',
          700: 'rgba(var(--app-border-subtle-rgb, 50, 50, 58), <alpha-value>)',
          600: 'rgba(var(--app-border-subtle-rgb, 68, 68, 78), <alpha-value>)',
          500: '#64748b',
          400: '#94a3b8',
          300: '#cbd5e1',
          200: '#e2e8f0',
          100: '#f4f4f5',
        },
        violet: {
          50: 'rgba(var(--theme-accent-rgb, 82, 82, 91), 0.1)',
          100: 'rgba(var(--theme-accent-rgb, 82, 82, 91), 0.15)',
          200: 'rgba(var(--theme-accent-rgb, 82, 82, 91), 0.28)',
          300: 'rgba(var(--theme-accent-light-rgb, 161, 161, 170), <alpha-value>)',
          400: 'rgba(var(--theme-accent-light-rgb, 161, 161, 170), <alpha-value>)',
          500: 'rgba(var(--theme-accent-hover-rgb, 63, 63, 70), <alpha-value>)',
          600: 'rgba(var(--theme-accent-rgb, 82, 82, 91), <alpha-value>)',
          700: 'rgba(var(--theme-accent-hover-rgb, 63, 63, 70), <alpha-value>)',
          800: 'rgba(var(--theme-accent-rgb, 82, 82, 91), 0.8)',
          900: 'rgba(var(--theme-accent-rgb, 82, 82, 91), 0.4)',
          950: 'rgba(var(--theme-accent-rgb, 82, 82, 91), 0.25)',
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        pixel: ['"Pixelify Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
