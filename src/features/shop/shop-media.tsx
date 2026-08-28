import { useState } from 'react'
import { ImageOff } from 'lucide-react'

// COMMERCE PRO C1/C2 (2026-08-28) -- shared image-thumbnail primitives.
// Originally built inline in ShopProductsPage.tsx (Phase C1); extracted
// here in Phase C2 so ShopPOSPage.tsx's product cards and category
// strip can reuse the exact same real-fallback/no-layout-jump pattern
// instead of re-inventing it. Both pages import from this module now.

// A real placeholder (not a broken-image icon): a neutral square with
// a centered icon, reserving the same aspect-ratio box the real image
// would occupy so there is never a layout jump switching between the
// two states.
export function ImagePlaceholder({ className }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-surface-muted text-text-secondary ${className ?? ''}`}>
      <ImageOff className="size-6" aria-hidden="true" />
    </div>
  )
}

export function ProductThumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <ImagePlaceholder className={className} />
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={`object-cover ${className ?? ''}`}
      onError={() => setFailed(true)}
    />
  )
}
