import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DirectionProvider } from './DirectionProvider'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

// NAVIGATION/TABS/RTL AUDIT (2026-08-23) -- regression guard for the
// real bug this pass found and fixed: @radix-ui/react-direction's own
// useDirection() hook (used internally by every Radix primitive --
// Tabs, Select, DropdownMenu, Dialog, Sheet) defaults to "ltr" whenever
// no <DirectionProvider> from THAT package wraps the tree, regardless
// of document.documentElement.dir. Confirmed live on the real app: a
// rendered TabsList had a literal dir="ltr" HTML attribute Radix set
// on itself, silently overriding the inherited RTL from <html
// dir="rtl">. This test would have caught that -- it does not just
// check document.documentElement.dir (App.test.tsx already covers
// that and it was ALWAYS correct; the bug was never there) but asserts
// on the actual DOM attribute Radix itself renders on the Tabs root,
// which is the thing that was actually wrong.
function ThreeTabs() {
  return (
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">First</TabsTrigger>
        <TabsTrigger value="b">Second</TabsTrigger>
        <TabsTrigger value="c">Third</TabsTrigger>
      </TabsList>
      <TabsContent value="a">A</TabsContent>
      <TabsContent value="b">B</TabsContent>
      <TabsContent value="c">C</TabsContent>
    </Tabs>
  )
}

describe('DirectionProvider + Radix direction propagation', () => {
  it('renders a Radix Tabs root with dir="rtl" when our own direction is rtl (the real bug: Radix defaulted to ltr here)', () => {
    render(
      <DirectionProvider>
        <ThreeTabs />
      </DirectionProvider>,
    )
    const tablist = screen.getByRole('tablist')
    // Radix's react-tabs sets `dir` explicitly on the Tabs.Root
    // element (an ancestor of the rendered [role="tablist"], not the
    // tablist itself) -- this is exactly the attribute the live-
    // browser investigation found set to "ltr" before this fix, via
    // `tablist.closest('[dir]')`.
    expect(tablist.closest('[dir]')?.getAttribute('dir')).toBe('rtl')
  })

  it('DOM order of tabs is unchanged by direction -- RTL visual mirroring is CSS/Radix-driven, not DOM reordering', () => {
    render(
      <DirectionProvider>
        <ThreeTabs />
      </DirectionProvider>,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['First', 'Second', 'Third'])
  })
})
