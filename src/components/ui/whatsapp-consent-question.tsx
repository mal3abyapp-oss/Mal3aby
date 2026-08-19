import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

// Directive correction: creating a customer record is NOT the
// customer's own consent to receive WhatsApp messages -- only the
// customer's own affirmative act is (e.g. submitting their own phone
// on the public booking form, which create_public_booking() already
// treats as consent). When STAFF enter a customer's phone on the
// customer's behalf, staff must explicitly ask the customer and
// record the answer -- never silently default to enabled=true just
// because a phone number was typed in.
//
// This is a real yes/no question with no pre-selected default,
// exactly mirroring the government-affiliation question pattern
// already used at onboarding (no nudge toward either answer).
export type WhatsappConsentAnswer = boolean | null

interface WhatsappConsentQuestionProps {
  value: WhatsappConsentAnswer
  onChange: (value: WhatsappConsentAnswer) => void
  disabled?: boolean
}

export function WhatsappConsentQuestion({ value, onChange, disabled }: WhatsappConsentQuestionProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <label className="text-sm font-medium text-text-secondary">
        {t('whatsappConsent.question')}
      </label>
      <p className="text-xs text-text-secondary">{t('whatsappConsent.hint')}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={value === true ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => onChange(true)}
        >
          {t('whatsappConsent.yes')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={value === false ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => onChange(false)}
        >
          {t('whatsappConsent.no')}
        </Button>
      </div>
    </div>
  )
}
