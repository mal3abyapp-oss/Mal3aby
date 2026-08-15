import type { Config } from 'tailwindcss'

// Design tokens sourced from docs/DESIGN_SYSTEM.md — do not hand-roll
// alternate values elsewhere; this file is the single source of truth
// for Tailwind-level tokens.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'dark-base': '#0B1220',
        'dark-secondary': '#111827',
        'page-bg': '#F7F8FA',
        surface: '#FFFFFF',
        'text-primary': '#111827',
        'text-secondary': '#667085',
        status: {
          success: '#12B76A',
          warning: '#F79009',
          danger: '#F04438',
          info: '#2E90FA',
          neutral: '#98A2B3',
        },
        // shadcn/ui component tokens — HSL CSS vars defined in src/index.css
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
      },
      fontFamily: {
        arabic: ['IBM Plex Sans Arabic', 'sans-serif'],
        sans: ['Inter', 'sans-serif'],
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
      },
      spacing: {
        // 4/8/12/16/24/32/48 scale — see docs/DESIGN_SYSTEM.md
        18: '4.5rem',
      },
    },
  },
  plugins: [],
} satisfies Config
