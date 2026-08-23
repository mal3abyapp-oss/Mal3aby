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
