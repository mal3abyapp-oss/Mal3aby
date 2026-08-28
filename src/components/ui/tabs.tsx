import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => {
  // Academy radical simplification directive (mobile-first requirement,
  // "no body horizontal overflow"): TabsList previously used plain
  // inline-flex with no overflow handling -- on a narrow viewport with
  // enough tabs/label length to exceed the screen width, this silently
  // pushed the whole page body wider instead of scrolling in place
  // (confirmed live: 4 Academy tabs measured document.body.scrollWidth
  // at 493px against a 375px viewport). max-w-full + overflow-x-auto
  // keeps this list scrollable within itself, matching the pattern
  // already used by FinanceNav/ReportsNav/MembershipsSection's own
  // sub-tab bars.
  //
  // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase C (2026-08-29): the
  // scroll itself worked, but there was no visible affordance that more
  // tabs existed off-screen -- confirmed live at 375px on Club Detail's
  // 5-tab bar (history/invoices/requests/audit/modules), where "الوحدات"
  // (Modules) sits past the fold with nothing hinting a swipe would
  // reveal it. A pure-CSS fade-to-background mask was tried first but
  // read as too subtle against the flat muted background to actually
  // register as "more content here" -- replaced with a real edge shadow
  // (a visibly darker gradient, not just a fade-to-transparent) that
  // only renders on the side(s) that still have unscrolled content,
  // tracked via a scroll listener since that state is inherently
  // dynamic (shows/hides as the user scrolls). This is the shared
  // TabsList used by 13 other screens -- the affordance is opt-in per
  // side based on actual overflow, so a tab bar that already fits
  // entirely on screen renders no shadow and looks identical to before.
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [edge, setEdge] = React.useState({ start: false, end: false })

  const updateEdges = React.useCallback(() => {
    const el = listRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    const maxScroll = scrollWidth - clientWidth
    if (maxScroll <= 1) {
      setEdge({ start: false, end: false })
      return
    }
    const rtl = getComputedStyle(el).direction === "rtl"
    // In RTL, this browser reports scrollLeft in [-maxScroll, 0]: 0 is
    // the reading-start edge (unscrolled, rightmost tabs visible) and
    // -maxScroll is fully scrolled toward the end (leftmost tabs
    // visible) -- so distance-from-start is simply the absolute value.
    // (Other engines are known to report RTL scrollLeft as [0, maxScroll]
    // instead; Math.abs is safe either way since distance-from-start is
    // never negative in either convention.)
    const distanceFromStart = rtl ? Math.abs(scrollLeft) : scrollLeft
    setEdge({
      start: distanceFromStart > 1,
      end: distanceFromStart < maxScroll - 1,
    })
  }, [])

  React.useEffect(() => {
    updateEdges()
    const el = listRef.current
    if (!el) return
    const resizeObserver = new ResizeObserver(updateEdges)
    resizeObserver.observe(el)
    return () => resizeObserver.disconnect()
  }, [updateEdges])

  return (
    <div className="relative max-w-full">
      <TabsPrimitive.List
        ref={(node) => {
          listRef.current = node
          if (typeof ref === "function") ref(node)
          else if (ref) ref.current = node
        }}
        onScroll={updateEdges}
        className={cn(
          "inline-flex h-9 max-w-full items-center justify-start gap-1 overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground",
          className
        )}
        {...props}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 start-0 w-4 rounded-s-lg bg-gradient-to-r from-foreground/15 to-transparent opacity-0 transition-opacity rtl:bg-gradient-to-l",
          edge.start && "opacity-100"
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 end-0 w-4 rounded-e-lg bg-gradient-to-l from-foreground/15 to-transparent opacity-0 transition-opacity rtl:bg-gradient-to-r",
          edge.end && "opacity-100"
        )}
      />
    </div>
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
