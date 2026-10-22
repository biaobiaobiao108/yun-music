/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./public/music/**/*.html', './frontend/player/src/**/*.{ts,tsx}', './public/music/js/**/*.js'],
  theme: {
    extend: {
      screens: {
        md: '1025px',
        lg: '1280px',
        xl: '1440px',
        '2xl': '1536px',
      },
      colors: {
        emerald: {
          50: 'var(--c-50)',
          100: 'var(--c-100)',
          200: 'var(--c-200)',
          300: 'var(--c-300)',
          400: 'var(--c-400)',
          500: 'var(--c-500)',
          600: 'var(--c-600)',
          700: 'var(--c-700)',
          800: 'var(--c-800)',
          900: 'var(--c-900)',
          950: 'var(--c-950)',
        },
      },
    },
  },
}
