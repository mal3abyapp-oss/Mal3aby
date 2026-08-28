import { useEffect, useState } from 'react'

// COMMERCE PRO C9 (2026-08-28) -- shared debounce hook. Found during the
// responsive/performance sweep (directive Section 28: "debounced search
// where appropriate") that no debounce mechanism existed anywhere in
// this codebase (confirmed via a full src/ grep) -- Shop's own POS
// product search, customer search, product management search, sales
// invoice-number search, and stock-count search all fed raw per-
// keystroke state directly into a React Query key, firing one network
// request per character typed. This hook is deliberately minimal and
// generic (not Shop-specific) so any future search input in the app can
// reuse it rather than reinventing debounce logic per call site.
//
// Usage: const debounced = useDebouncedValue(rawInput, 300); then key a
// useQuery/queryFn off `debounced`, not `rawInput` -- the input itself
// still updates instantly (no typing lag), only the query firing is
// delayed.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
