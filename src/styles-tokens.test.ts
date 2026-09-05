import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// SELECT/DROPDOWN/POPOVER AUDIT (2026-08-23) -- regression guard for
// the real bug this pass found and fixed: select.tsx/dropdown-menu.tsx
// both use the shadcn `bg-popover`/`text-popover-foreground` utility
// classes, but --popover/--popover-foreground were never defined in
// src/index.css, and `popover` was never mapped in tailwind.config.ts
// -- every sibling shadcn token (background, primary, secondary,
// muted, border, input, ring) had both, this pair silently didn't.
// Tailwind generated no CSS rule for bg-popover at all, so the
// computed background-color fell back to transparent -- confirmed
// live: an open SelectContent's backgroundColor was exactly
// "rgba(0, 0, 0, 0)", letting page content behind it show/overlap
// through the dropdown (Academy Attendance's membership select,
// Finance Cash Shifts' branch/status filters).
//
// A real CSS pipeline isn't wired into this Vitest/jsdom test
// environment (see vitest.config.ts / src/test-setup.ts -- no
// index.css import, no PostCSS/Tailwind processing step), so this
// can't assert on a computed style the way the live-browser
// investigation did. This instead asserts directly on the two source
// files staying in sync with each other: every shadcn color token
// object in tailwind.config.ts's `colors` block must have a matching
// CSS custom property defined in index.css's :root block -- the exact
// class of drift that caused this bug. A future edit that adds a new
// tailwind.config.ts color token (or removes one from index.css)
// without updating the other trips this test immediately, rather than
// silently rendering as invisible/transparent in production.
describe('shadcn color token contract (tailwind.config.ts <-> index.css)', () => {
  const configSource = fs.readFileSync(path.resolve(__dirname, '../tailwind.config.ts'), 'utf-8')
  const cssSource = fs.readFileSync(path.resolve(__dirname, './index.css'), 'utf-8')

  // Every `hsl(var(--xxx))` reference in the config names a CSS custom
  // property that MUST exist in index.css's :root block.
  const referencedVars = Array.from(configSource.matchAll(/hsl\(var\((--[a-z-]+)\)\)/g))
    .map((m) => m[1])
    .filter((v): v is string => !!v)

  it('found at least the known shadcn tokens in tailwind.config.ts (sanity check the regex above still matches real content)', () => {
    expect(referencedVars).toEqual(expect.arrayContaining(['--background', '--primary', '--popover', '--border']))
  })

  it.each(Array.from(new Set(referencedVars)))('tailwind.config.ts references %s -- it must be defined in index.css', (varName: string) => {
    // Matches "  --popover: 0 0% 100%;" style declarations inside :root.
    const declared = new RegExp(`${varName}\\s*:\\s*[^;]+;`).test(cssSource)
    expect(declared).toBe(true)
  })

  it('popover token specifically resolves to a real (non-empty) HSL triple, not left blank', () => {
    const match = cssSource.match(/--popover:\s*([^;]+);/)
    const value = match?.[1] ?? ''
    expect(value.trim().length).toBeGreaterThan(0)
  })
})

// VISUAL AUDIT B1 / RTL-A11Y-01 (2026-09-05): a second class of the same
// drift the popover bug caught, but for the plain-hex (non-hsl(var())
// color tokens -- --color-*, --status-* -- that tailwind.config.ts's
// `colors` block re-types as literal hex (dark-base, page-bg, surface,
// text-primary, text-secondary, status.success/warning/danger/info/
// neutral, accent-emphasis, accent-light, accent-dark). These aren't
// caught by the hsl(var()) regex above because they're plain hex
// literals in both files rather than a CSS-var indirection, so a future
// edit to one file without the other would silently drift with no
// build error. This asserts the two files agree, hex-for-hex
// (case-insensitively), for every token in this hand-maintained map.
describe('plain-hex color token contract (tailwind.config.ts <-> index.css)', () => {
  const configSource = fs.readFileSync(path.resolve(__dirname, '../tailwind.config.ts'), 'utf-8')
  const cssSource = fs.readFileSync(path.resolve(__dirname, './index.css'), 'utf-8')

  // tailwind.config.ts key -> index.css custom property name.
  const tokenMap: Record<string, string> = {
    'dark-base': '--color-dark-base',
    'dark-secondary': '--color-dark-secondary',
    'page-bg': '--color-page-bg',
    surface: '--color-surface',
    'text-primary': '--color-text-primary',
    'text-secondary': '--color-text-secondary',
    'accent-emphasis': '--color-accent-emphasis',
    'accent-light': '--color-accent-light',
    'accent-dark': '--color-accent-dark',
  }
  const statusMap: Record<string, string> = {
    success: '--status-success',
    warning: '--status-warning',
    danger: '--status-danger',
    info: '--status-info',
    neutral: '--status-neutral',
  }

  function hexFromConfig(key: string): string | undefined {
    // Matches both quoted keys ('dark-base': '#0B1220') and bare
    // identifier keys (surface: '#FFFFFF').
    const match = configSource.match(new RegExp(`['"]?${key}['"]?\\s*:\\s*['"](#[0-9a-fA-F]{3,8})['"]`))
    return match?.[1]
  }
  function hexFromStatusConfig(key: string): string | undefined {
    const match = configSource.match(new RegExp(`${key}\\s*:\\s*['"](#[0-9a-fA-F]{3,8})['"]`))
    return match?.[1]
  }
  function hexFromCss(varName: string): string | undefined {
    const match = cssSource.match(new RegExp(`${varName}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`))
    return match?.[1]
  }

  it.each(Object.entries(tokenMap))('tailwind.config.ts colors.%s matches index.css %s', (key, cssVar) => {
    const configHex = hexFromConfig(key)
    const cssHex = hexFromCss(cssVar)
    expect(configHex, `tailwind.config.ts should define colors['${key}'] as a hex literal`).toBeTruthy()
    expect(cssHex, `index.css should define ${cssVar}`).toBeTruthy()
    expect(configHex?.toLowerCase()).toBe(cssHex?.toLowerCase())
  })

  it.each(Object.entries(statusMap))('tailwind.config.ts colors.status.%s matches index.css %s', (key, cssVar) => {
    const configHex = hexFromStatusConfig(key)
    const cssHex = hexFromCss(cssVar)
    expect(configHex, `tailwind.config.ts should define colors.status['${key}']`).toBeTruthy()
    expect(cssHex, `index.css should define ${cssVar}`).toBeTruthy()
    expect(configHex?.toLowerCase()).toBe(cssHex?.toLowerCase())
  })
})

// RTL-A11Y-01 (2026-09-05): the 5 status tokens are used directly as
// text color (text-status-*) in 40+ places across the app (form
// validation errors, status labels, required-field asterisks), not
// only as icon/badge tints. This asserts each one clears WCAG AA's
// 4.5:1 normal-text contrast minimum against both page backgrounds the
// app actually renders text on (--color-surface #fff and
// --color-page-bg #f7f8fa), so a future "just nudge the color a bit"
// edit can't silently regress back below the accessible threshold.
describe('status token text contrast (WCAG AA, >=4.5:1)', () => {
  const cssSource = fs.readFileSync(path.resolve(__dirname, './index.css'), 'utf-8')

  function hexToRgb(hex: string): [number, number, number] {
    const clean = hex.replace('#', '')
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
    const n = parseInt(full, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  function srgbToLinear(c: number): number {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  function relativeLuminance([r, g, b]: [number, number, number]): number {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
  }
  function contrastRatio(hexA: string, hexB: string): number {
    const lA = relativeLuminance(hexToRgb(hexA)) + 0.05
    const lB = relativeLuminance(hexToRgb(hexB)) + 0.05
    return lA > lB ? lA / lB : lB / lA
  }
  function cssVar(varName: string): string {
    const match = cssSource.match(new RegExp(`${varName}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`))
    if (!match?.[1]) throw new Error(`${varName} not found in index.css`)
    return match[1]
  }

  const surface = cssVar('--color-surface')
  const pageBg = cssVar('--color-page-bg')
  const statusVars = ['--status-success', '--status-warning', '--status-danger', '--status-info', '--status-neutral']

  it.each(statusVars)('%s clears 4.5:1 against --color-surface', (varName) => {
    expect(contrastRatio(cssVar(varName), surface)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(statusVars)('%s clears 4.5:1 against --color-page-bg', (varName) => {
    expect(contrastRatio(cssVar(varName), pageBg)).toBeGreaterThanOrEqual(4.5)
  })

  // INDEPENDENT REVIEW F1/F2 (2026-09-05): --color-accent-emphasis is
  // used as normal-size text (HomePage eyebrow labels/underlines) and
  // carried the same "clears 4.5:1 against both backgrounds" claim as
  // the status tokens above, but had no enforcing test of its own —
  // the initial value (#568200) actually failed against
  // --color-page-bg (4.307:1), caught only by manual/live review.
  // This closes that gap so a future retune can't silently regress.
  it('--color-accent-emphasis clears 4.5:1 against --color-surface', () => {
    expect(contrastRatio(cssVar('--color-accent-emphasis'), surface)).toBeGreaterThanOrEqual(4.5)
  })

  it('--color-accent-emphasis clears 4.5:1 against --color-page-bg', () => {
    expect(contrastRatio(cssVar('--color-accent-emphasis'), pageBg)).toBeGreaterThanOrEqual(4.5)
  })
})
