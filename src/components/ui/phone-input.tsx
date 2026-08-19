import { useState, useEffect, useId } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { normalizePhone, convertArabicDigits, type NormalizePhoneResult } from '@/lib/domain/phone'
import { cn } from '@/lib/utils'

// Directive section 5/6: every phone input is a country selector + a
// plain local-format text field, defaulting to the club's country but
// always explicitly overridable -- never a forced country. Directive
// section 61/62/63: mobile numeric keyboard, bdi-wrapped E.164 preview
// so it never mis-renders inside RTL text, and a real <label> for
// each control.
//
// This list is deliberately small (this market + neighbors) rather
// than all ~240 ISO countries -- extend as the product actually needs
// more markets. It does not gate what libphonenumber-js can parse;
// it only gates what shows in the picker.
const COUNTRY_OPTIONS: Array<{ code: CountryCode; flag: string; labelKey: string; dialCode: string }> = [
  { code: 'EG', flag: '🇪🇬', labelKey: 'phoneInput.countries.EG', dialCode: '+20' },
  { code: 'AE', flag: '🇦🇪', labelKey: 'phoneInput.countries.AE', dialCode: '+971' },
  { code: 'SA', flag: '🇸🇦', labelKey: 'phoneInput.countries.SA', dialCode: '+966' },
  { code: 'KW', flag: '🇰🇼', labelKey: 'phoneInput.countries.KW', dialCode: '+965' },
  { code: 'QA', flag: '🇶🇦', labelKey: 'phoneInput.countries.QA', dialCode: '+974' },
  { code: 'JO', flag: '🇯🇴', labelKey: 'phoneInput.countries.JO', dialCode: '+962' },
]

export interface PhoneInputValue {
  raw: string
  country: CountryCode
}

interface PhoneInputProps {
  label: string
  value: PhoneInputValue
  onChange: (value: PhoneInputValue) => void
  onValidChange?: (result: NormalizePhoneResult) => void
  required?: boolean
  disabled?: boolean
  error?: string | null
  /** Shown once the input has real content and validation has run. */
  showValidation?: boolean
}

export function PhoneInput({ label, value, onChange, onValidChange, required, disabled, error, showValidation = true }: PhoneInputProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const [touched, setTouched] = useState(false)
  const [result, setResult] = useState<NormalizePhoneResult>(() => normalizePhone(value.raw, value.country))

  useEffect(() => {
    const r = normalizePhone(value.raw, value.country)
    setResult(r)
    onValidChange?.(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.raw, value.country])

  const selectedCountry = COUNTRY_OPTIONS.find((c) => c.code === value.country) ?? COUNTRY_OPTIONS[0]!
  const showError = touched && showValidation && value.raw.trim().length > 0 && !result.valid
  const errorId = `${inputId}-error`

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
        {required && <span className="text-status-danger"> *</span>}
      </label>
      <div className="flex gap-2">
        <Select
          value={value.country}
          onValueChange={(country) => onChange({ ...value, country: country as CountryCode })}
          disabled={disabled}
        >
          <SelectTrigger className="w-[6.5rem] shrink-0" aria-label="Country">
            <SelectValue>
              <span className="flex items-center gap-1">
                <span aria-hidden="true">{selectedCountry.flag}</span>
                <bdi className="tabular-nums">{selectedCountry.dialCode}</bdi>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {COUNTRY_OPTIONS.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                <span className="flex items-center gap-2">
                  <span aria-hidden="true">{c.flag}</span>
                  <bdi className="tabular-nums">{c.dialCode}</bdi>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id={inputId}
          type="tel"
          inputMode="tel"
          dir="ltr"
          className={cn('flex-1', showError && 'border-status-danger focus-visible:ring-status-danger')}
          value={value.raw}
          onChange={(e) => onChange({ ...value, raw: convertArabicDigits(e.target.value) })}
          onBlur={() => setTouched(true)}
          disabled={disabled}
          aria-invalid={showError || !!error}
          aria-describedby={showError || error ? errorId : undefined}
          placeholder="01xxxxxxxxx"
        />
      </div>
      {(showError || error) && (
        <p id={errorId} className="text-xs text-status-danger">
          {error ?? t('phoneInput.invalidError')}
        </p>
      )}
    </div>
  )
}

export { COUNTRY_OPTIONS }
