import * as fontkit from 'fontkit'
import { render as bidiRender } from 'bidi-shaper'

/**
 * ArabicTextRenderer -- correct Arabic PDF text rendering (directive
 * Sections 33-36).
 *
 * ================================================================
 * ROOT CAUSE (proven, 2026-08-19): the previous implementation used
 * `bidi-shaper/pdfkit`'s `textBidi()`, which correctly does BOTH the
 * Arabic contextual-shaping pass AND the UAX#9 bidi-reordering pass,
 * then hands the result (an already-shaped, already-visual-order
 * string of PRESENTATION-FORM codepoints, e.g. U+FEE7) to pdfkit's
 * normal `doc.text()`. The library's own `features: []` option is
 * documented to disable "fontkit's own substitutions" for that call --
 * but reading fontkit's source directly (LayoutEngine.substitute() ->
 * OTLayoutEngine.substitute() -> ArabicShaper.plan()) shows the
 * Arabic shaper's joining-state-machine ALWAYS runs whenever the
 * detected script is Arabic, regardless of the user-supplied features
 * list -- `features: []` only skips OPTIONAL user-selectable OpenType
 * features, not the mandatory per-script shaping plan. Unicode's
 * ArabicShaping.txt (which fontkit's joining-type lookup is built
 * from) does not classify PRESENTATION FORMS at all -- only base
 * Arabic letters -- so every presentation-form glyph the previous
 * approach fed into fontkit landed in the `Non_Joining` bucket and
 * was re-shaped incorrectly a second time. Proven via direct glyph-ID
 * inspection (fontkit.layout() on bidi-shaper's presentation-form
 * output produced a genuinely different, wrong glyph SET compared to
 * shaping the same text from its original logical-order base letters)
 * and confirmed visually: real multi-word Arabic values (e.g. a field
 * name "ملعب 1 - كرة قدم") rendered as visibly scrambled, wrong text
 * in the actual generated PDF (rasterized and inspected directly,
 * not just extracted-text-order -- this is a genuine VISUAL defect,
 * matching the user's original complaint).
 *
 * FIX: bypass fontkit's `.text()`/`.layout()` pipeline for Arabic text
 * entirely. bidi-shaper's `render()` (shaping + UAX#9 reordering) is
 * itself CORRECT for the string as a whole -- proven via a rasterized
 * visual comparison against real Arabic PDF output. What was wrong
 * was handing that already-final presentation-form string back into a
 * pipeline that re-interprets it. Instead: after bidi-shaper produces
 * the final presentation-form, visual-order string, each resulting
 * codepoint's glyph is looked up directly via fontkit's own cmap
 * (`glyphForCodePoint`) -- a plain character-to-glyph-ID table lookup
 * with NO GSUB substitution pass involved at all -- and drawn as a raw
 * vector path via pdfkit's low-level `doc.path()`, completely
 * sidestepping `doc.text()`/`.layout()`.
 *
 * Per-glyph Latin fallback (directive Section 35, mixed RTL/LTR
 * protection): Noto Sans Arabic has no Latin LETTER glyphs at all
 * (confirmed: `characterSet.includes(0x45)` is false) -- confirmed via
 * `glyphForCodePoint()` returning glyph id 0 (.notdef, a visible tofu
 * box, NOT an empty/missing glyph) for any Latin letter. Every glyph
 * lookup here checks `characterSet.includes(codepoint)` FIRST and
 * falls back to the Latin font (which DOES cover Latin letters +
 * digits + punctuation) glyph-by-glyph, so a mixed string like
 * "INV-2026-000123" or a booking ref "MB-1A2B3C4D" renders correctly
 * with each character's own correct glyph -- never a tofu box, never
 * two independently-shaped runs mixed into the same line the way the
 * original per-field two-column layout worked around this gap.
 *
 * bidi-shaper remains the ONLY thing responsible for reordering/
 * shaping -- this module never reverses a string manually and never
 * reimplements UAX#9 (directive Section 33's explicit prohibition).
 */

export interface RenderFonts {
  arabic: fontkit.Font
  arabicBold: fontkit.Font
  latin: fontkit.Font
  latinBold: fontkit.Font
  /** Original file paths -- kept alongside the parsed fontkit.Font objects so drawArabicText() can also register these same font FILES with pdfkit itself (doc.registerFont()), needed only for the invisible searchable-text layer below (pdfkit's own text-embedding path, not the vector-drawing path this module otherwise uses exclusively). */
  paths: { arabic: string; arabicBold: string; latin: string; latinBold: string }
}

export function loadRenderFonts(paths: { arabic: string; arabicBold: string; latin: string; latinBold: string }): RenderFonts {
  return {
    arabic: fontkit.openSync(paths.arabic) as fontkit.Font,
    arabicBold: fontkit.openSync(paths.arabicBold) as fontkit.Font,
    latin: fontkit.openSync(paths.latin) as fontkit.Font,
    latinBold: fontkit.openSync(paths.latinBold) as fontkit.Font,
    paths,
  }
}

interface ResolvedGlyph {
  font: fontkit.Font
  glyphId: number
}

/** Resolves one codepoint to a glyph, preferring the Arabic font and falling back to the Latin font for any codepoint the Arabic font's cmap doesn't cover (directive Section 35). */
function resolveGlyph(codePoint: number, primary: fontkit.Font, fallback: fontkit.Font): ResolvedGlyph {
  if (primary.characterSet.includes(codePoint)) {
    return { font: primary, glyphId: primary.glyphForCodePoint(codePoint).id }
  }
  if (fallback.characterSet.includes(codePoint)) {
    return { font: fallback, glyphId: fallback.glyphForCodePoint(codePoint).id }
  }
  // Neither font covers it -- fall through to the primary font's
  // .notdef so the caller gets *something* drawable rather than a
  // thrown error, matching how every other renderer (browsers
  // included) handles a genuinely unsupported character.
  return { font: primary, glyphId: 0 }
}

/**
 * Draws `text` (logical order, may contain Arabic, Latin, digits,
 * punctuation) with its RIGHT edge anchored at `xRightEdge` -- the
 * standard convention for a right-aligned Arabic/RTL line. `doc` is a
 * PDFKit document already positioned at the desired baseline via `y`.
 * Returns the total rendered width (points) so callers can lay out
 * adjacent content.
 */
export function drawArabicText(
  doc: PDFKit.PDFDocument,
  text: string,
  xRightEdge: number,
  y: number,
  fontSize: number,
  fonts: RenderFonts,
  opts: { bold?: boolean; color?: string } = {},
): number {
  if (!text) return 0
  const primary = opts.bold ? fonts.arabicBold : fonts.arabic
  const fallback = opts.bold ? fonts.latinBold : fonts.latin
  const color = opts.color ?? '#000000'

  // The ONE call responsible for shaping (Arabic contextual joining)
  // and UAX#9 bidi reordering -- proven correct as a whole-string
  // operation via direct visual rasterization. Never reimplemented,
  // never manually reversed.
  const shaped = bidiRender(text)
  const codePoints = [...shaped].map((ch) => ch.codePointAt(0)!)

  const resolved = codePoints.map((cp) => resolveGlyph(cp, primary, fallback))
  const widths = resolved.map(({ font, glyphId }) => (font.getGlyph(glyphId).advanceWidth * fontSize) / font.unitsPerEm)
  const totalWidth = widths.reduce((sum, w) => sum + w, 0)

  let x = xRightEdge - totalWidth
  doc.fillColor(color)
  for (let i = 0; i < resolved.length; i++) {
    const { font, glyphId } = resolved[i]
    if (glyphId !== 0) {
      const scale = fontSize / font.unitsPerEm
      const svgPath = font.getGlyph(glyphId).path.toSVG()
      if (svgPath) {
        doc.save()
        doc.translate(x, y)
        doc.scale(scale, -scale)
        doc.path(svgPath).fill(color)
        doc.restore()
      }
    }
    x += widths[i]
  }
  doc.fillColor('#000000')

  drawInvisibleTextLayer(doc, text, xRightEdge - totalWidth, y - fontSize, totalWidth, fontSize, fonts, opts.bold ?? false)

  return totalWidth
}

/**
 * Registers (once per document) and returns the pdfkit-visible font
 * name for one of this module's four font files -- needed only by the
 * invisible text layer below, which draws through pdfkit's OWN
 * `.text()` (the normal font-embedding path), not the vector-path
 * drawing this module otherwise uses exclusively for visible glyphs.
 */
function registeredFontName(doc: PDFKit.PDFDocument, fonts: RenderFonts, which: 'arabic' | 'arabicBold' | 'latin' | 'latinBold'): string {
  const name = `__ArabicTextRenderer_${which}`
  const docWithRegistry = doc as unknown as { _registeredArabicFonts?: Set<string> }
  docWithRegistry._registeredArabicFonts ??= new Set()
  if (!docWithRegistry._registeredArabicFonts.has(name)) {
    docWithRegistry._registeredArabicFonts.add(name)
    doc.registerFont(name, fonts.paths[which])
  }
  return name
}

/**
 * Invisible text layer (PDF render mode 3, "neither fill nor stroke")
 * laid UNDER the correct vector glyphs drawn above, purely so the
 * document has real selectable/searchable/copy-pasteable text -- the
 * vector drawing above is what a viewer actually SEES, and is
 * provably correct (see this file's own doc comment); this layer is
 * strictly a searchability/accessibility improvement, never the
 * primary correctness guarantee.
 *
 * Splits `text` into contiguous runs by SCRIPT (Arabic-range vs.
 * everything else) -- NOT by the same per-character glyph-fallback
 * logic drawArabicText() uses for vector glyphs, and deliberately
 * without any bidi/reordering pass: this layer's job is only to give
 * PDF.js/Acrobat's own text-extraction the correct LOGICAL characters
 * to recover (they reconstruct reading order from glyph positions
 * themselves), each run drawn through pdfkit's normal per-font
 * text-embedding path with a real ToUnicode CMap so the exact
 * original characters (not presentation forms) are what gets
 * embedded. Position/width here doesn't need to be pixel-exact (it's
 * invisible) -- it only needs to place each run under roughly the
 * right visible glyphs, which the same left-to-right run order and
 * widths already computed above satisfy well enough for extraction.
 */
function drawInvisibleTextLayer(
  doc: PDFKit.PDFDocument,
  text: string,
  xLeftEdge: number,
  yBaseline: number,
  totalWidth: number,
  fontSize: number,
  fonts: RenderFonts,
  bold: boolean,
): void {
  const chars = [...text]
  type Run = { chars: string; isArabic: boolean }
  const runs: Run[] = []
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!
    const isArabic = fonts.arabic.characterSet.includes(cp) && !fonts.latin.characterSet.includes(cp)
    const last = runs[runs.length - 1]
    if (last && last.isArabic === isArabic) {
      last.chars += ch
    } else {
      runs.push({ chars: ch, isArabic })
    }
  }

  // Widths for invisible-layer positioning use each run's OWN font's
  // natural (unshaped) advance widths -- an approximation, but one
  // that only affects where invisible/unseen text sits, never what a
  // viewer sees.
  const runWidths = runs.map((run) => measureWithPdfkitFont(doc, run.isArabic ? 'arabic' : 'latin', bold, run.chars, fontSize, fonts))
  const runsTotalWidth = runWidths.reduce((s, w) => s + w, 0) || 1
  const scaleToFit = totalWidth / runsTotalWidth

  let x = xLeftEdge
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const w = runWidths[i] * scaleToFit
    const fontKey = run.isArabic ? (bold ? 'arabicBold' : 'arabic') : bold ? 'latinBold' : 'latin'
    const fontName = registeredFontName(doc, fonts, fontKey)
    doc.font(fontName).fontSize(fontSize)
    doc.addContent('3 Tr')
    doc.text(run.chars, x, yBaseline, { lineBreak: false })
    doc.addContent('0 Tr')
    x += w
  }
}

function measureWithPdfkitFont(doc: PDFKit.PDFDocument, kind: 'arabic' | 'latin', bold: boolean, text: string, fontSize: number, fonts: RenderFonts): number {
  const fontKey = kind === 'arabic' ? (bold ? 'arabicBold' : 'arabic') : bold ? 'latinBold' : 'latin'
  const fontName = registeredFontName(doc, fonts, fontKey)
  const previousFont = (doc as unknown as { _font?: { name?: string } })._font
  doc.font(fontName).fontSize(fontSize)
  const width = doc.widthOfString(text)
  if (previousFont?.name) doc.font(previousFont.name)
  return width
}

/** Measures the rendered width of `text` at `fontSize` without drawing it -- for layout decisions (e.g. checking if a value fits before choosing a row style). Uses the same shaping/fallback path as drawArabicText() so measurements are always consistent with what actually gets drawn. */
export function measureArabicText(text: string, fontSize: number, fonts: RenderFonts, opts: { bold?: boolean } = {}): number {
  if (!text) return 0
  const primary = opts.bold ? fonts.arabicBold : fonts.arabic
  const fallback = opts.bold ? fonts.latinBold : fonts.latin
  const shaped = bidiRender(text)
  const codePoints = [...shaped].map((ch) => ch.codePointAt(0)!)
  return codePoints.reduce((sum, cp) => {
    const { font, glyphId } = resolveGlyph(cp, primary, fallback)
    return sum + (font.getGlyph(glyphId).advanceWidth * fontSize) / font.unitsPerEm
  }, 0)
}
