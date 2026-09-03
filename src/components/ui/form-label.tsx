import { cn } from '@/lib/utils'
import type { LabelHTMLAttributes } from 'react'

// Production audit remediation, P3 (2026-09-03): the audit found 321
// <label> occurrences across 63 files vs. only 21 correctly paired with
// htmlFor/id, because no shared Label primitive existed -- the correct
// pairing was done manually per-field rather than componentized, so it
// drifted. This component is the root-cause fix: it requires htmlFor
// (TypeScript enforces it's present, not optional) so a field using it
// cannot silently omit the association a screen reader needs to announce
// an accessible name for the paired input.
//
// Scope note: per the master remediation directive's "do not chase
// advisory noise disproportionately" guidance, this P3 pass introduces
// the correct building block rather than retrofitting all 63 existing
// files -- that sweep is a larger, separately-scoped follow-up. New/
// touched forms should use this component going forward.
export interface FormLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor: string
  required?: boolean
}

export function FormLabel({ htmlFor, required, className, children, ...props }: FormLabelProps) {
  return (
    <label htmlFor={htmlFor} className={cn('text-sm font-medium text-text-primary', className)} {...props}>
      {children}
      {required && <span className="text-status-danger ms-0.5" aria-hidden="true">*</span>}
    </label>
  )
}
