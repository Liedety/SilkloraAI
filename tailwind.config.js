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
          950: '#07090e',
          900: '#0c0f17',
          850: '#111520',
          800: '#161b2a',
          700: '#20273c',
          600: '#2d3752',
          500: '#485579',
          400: '#7c8ba1',
          300: '#adb8cb',
          200: '#dce2ee',
          100: '#f1f4fa',
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
