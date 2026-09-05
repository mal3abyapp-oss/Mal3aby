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
        // Darker-lime derivative of accent for readable text on light
        // backgrounds — see src/index.css --color-accent-emphasis.
        'accent-emphasis': '#4E7500',
        // Lighter/darker gradient-stop derivatives of accent for the
        // rare full-bleed brand gradient surface — see src/index.css
        // --color-accent-light / --color-accent-dark.
        'accent-light': '#C7FF5C',
        'accent-dark': '#9FE032',
        // WCAG AA contrast remediation (2026-09-05) — darkened within
        // the same hue family so text-status-* clears 4.5:1 against
        // white/page-bg; keep in sync with src/index.css --status-*.
        status: {
          success: '#0B7A45',
          warning: '#A35F06',
          danger: '#DC2418',
          info: '#0468D7',
          neutral: '#64718A',
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
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
      },
      // VISUAL AUDIT B3 (2026-09-05): these font-arabic/font-sans
      // utility classes are not used anywhere in src/ — the actual,
      // single font-selection mechanism is the global `html` /
      // `html[dir='ltr']` rule in src/index.css (lines ~59-65), which
      // switches the whole document's font-family by direction in one
      // place. That is the real, intentional pattern; these tokens are
      // kept only so a future per-component override (e.g. forcing
      // Latin font on an embedded English-only widget inside an Arabic
      // page) has a ready-made utility class rather than a one-off
      // inline style — not currently used anywhere.
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
