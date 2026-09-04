import { describe, it, expect } from 'vitest'
import { evaluateOutreachQuality, findPlaceholders, wordCount } from './outreach-quality-gate'

// Commercial Outreach Quality Gate regression suite (2026-09-04, owner
// directive): "Add regression tests proving rejection of: empty
// subject, literal placeholders, missing signature, missing CTA,
// overlong first-contact email, unsupported claim, low-confidence
// inference stated as certainty, call task with fewer than 2 discovery
// questions, call task without literal opening, call task without
// objection handling. Also test valid Arabic and English drafts."

const VALID_EMAIL_EN = {
  channel: 'email' as const,
  language: 'en' as const,
  subject: 'Quick question about Elmasry Football Academy\'s registration process',
  body: `Hi Elmasry Football Academy team,

I noticed your academy is active on Instagram and Facebook in 6 October City, with a lot of engagement from players and parents.

We couldn't find a dedicated online registration or attendance system in what we reviewed publicly, so I wanted to ask how you currently handle player registration and monthly subscriptions.

Mal3aby helps academies like yours move that into one simple system, cutting down on manual paperwork.

Would a quick 10-minute call this week work to hear more about how you currently manage this?

Mal3aby Sales Team
sales@mal3aby.app`,
  lowConfidenceSignalKeys: [],
  groundingPassed: true,
}

const VALID_EMAIL_AR = {
  channel: 'email' as const,
  language: 'ar' as const,
  subject: 'سؤال سريع عن نظام التسجيل في أكاديمية المصري',
  body: `تحية طيبة لفريق أكاديمية المصري لكرة القدم،

لاحظنا نشاطكم على انستجرام وفيسبوك في مدينة 6 أكتوبر، مع تفاعل جيد من اللاعبين وأولياء الأمور.

لم نتمكن من تحديد وجود نظام تسجيل إلكتروني من خلال ما اطلعنا عليه علنًا، فحبيت أسأل إزاي بيتم تسجيل اللاعبين وتحصيل الاشتراكات حاليًا؟

ملعبي بيساعد الأكاديميات زيكم على تنظيم التسجيل والاشتراكات في مكان واحد بدل الأوراق.

هل يناسبكم مكالمة قصيرة ١٠ دقايق الأسبوع ده للتعرف أكتر على الموضوع؟

فريق ملعبي
sales@mal3aby.app`,
  lowConfidenceSignalKeys: [],
  groundingPassed: true,
}

const VALID_CALL_TASK_AR = {
  channel: 'phone_script' as const,
  language: 'ar' as const,
  subject: null,
  body: `افتتاحية:
"معاك من فريق ملعبي، منصة لإدارة الأكاديميات والملاعب الرياضية. عندك دقيقتين أتكلم معاك؟"

أسئلة استكشافية:
1. إزاي بيتم تسجيل اللاعبين الجدد حاليًا؟
2. إزاي بتحصلوا الاشتراكات الشهرية؟
3. هل عندكم نظام لتسجيل الحضور؟

فرضية المشكلة: الاعتماد على فيسبوك فقط للتواصل قد يعني عمليات تسجيل يدوية.

القيمة المقترحة: نظام تسجيل وحضور واشتراكات في مكان واحد.

الرد على الاعتراضات:
- "عندنا نظام بالفعل": تمام، ملعبي بيتكامل أو بيبسط الموضوع أكتر، تحب أوريك الفرق في عرض قصير؟
- "ابعتلي معلومات": أكيد هبعتلك، بس عايز أفهم احتياجك الأول عشان ابعتلك اللي يناسبك بالظبط.
- "مش مهتم دلوقتي": مفهوم، ممكن أرجعلك بعد فترة لو الوقت يبقى أنسب؟

الخطوة التالية: هل يناسبكم عرض ١٠ دقايق الأسبوع ده؟`,
  lowConfidenceSignalKeys: [],
  groundingPassed: true,
}

describe('evaluateOutreachQuality — email', () => {
  it('accepts a valid, well-formed English first-contact email', () => {
    const result = evaluateOutreachQuality(VALID_EMAIL_EN)
    expect(result.status).toBe('APPROVAL_READY')
    expect(result.rejection_reasons).toEqual([])
  })

  it('accepts a valid, well-formed Arabic first-contact email', () => {
    const result = evaluateOutreachQuality(VALID_EMAIL_AR)
    expect(result.status).toBe('APPROVAL_READY')
    expect(result.rejection_reasons).toEqual([])
  })

  it('rejects an email with an empty/null subject', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, subject: null })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_SUBJECT')
    expect(result.gates.SUBJECT_PASS).toBe(false)
  })

  it('rejects an email with an empty-string subject', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, subject: '   ' })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_SUBJECT')
  })

  it('rejects an email with literal bracket placeholders', () => {
    const body = VALID_EMAIL_EN.body.replace('Elmasry Football Academy team', '[Prospect Name]').replace('Mal3aby Sales Team\nsales@mal3aby.app', '[Your Name]\n[Your Title] – Mal3aby\n[Contact Information]')
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('UNRESOLVED_PLACEHOLDER')
    expect(result.gates.PLACEHOLDER_PASS).toBe(false)
  })

  it('detects placeholders generically -- {{...}}, <...>, TODO, TBD, YOUR_NAME', () => {
    expect(findPlaceholders('Hello {{first_name}}')).toContain('{{first_name}}')
    expect(findPlaceholders('Sincerely, <Your Name>')).toContain('<Your Name>')
    expect(findPlaceholders('Phone: TODO')).toContain('TODO')
    expect(findPlaceholders('Price: TBD')).toContain('TBD')
    expect(findPlaceholders('Signed, YOUR_NAME')).toContain('YOUR_NAME')
  })

  it('rejects an email with no closing signature', () => {
    const body = VALID_EMAIL_EN.body.replace('Mal3aby Sales Team\nsales@mal3aby.app', 'Thanks.')
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_SIGNATURE')
  })

  it('rejects an email with no call to action at all', () => {
    const body = VALID_EMAIL_EN.body.replace('Would a quick 10-minute call this week work to hear more about how you currently manage this?', 'Let us know if you have any thoughts.')
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_CTA')
  })

  it('rejects a vague CTA that mentions a demo but asks no question and gives no timeframe', () => {
    const body = VALID_EMAIL_EN.body.replace(
      'Would a quick 10-minute call this week work to hear more about how you currently manage this?',
      'We would love to arrange a demo for you at some point.',
    )
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('WEAK_CTA')
  })

  it('rejects an excessively long first-contact email', () => {
    const longBody = VALID_EMAIL_EN.body + '\n\n' + 'This is additional filler content padding out the message far beyond a reasonable first-contact length. '.repeat(20)
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, body: longBody })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MESSAGE_TOO_LONG')
  })

  it('rejects an email that dumps more than 3 unrelated product features as a bullet list', () => {
    const body = `Hi team,

We noticed your academy has no dedicated website.

Mal3aby offers:
- Player registration
- QR attendance tracking
- Parent profiles
- Subscription billing
- Automated notifications

Would a quick call work this week?

Mal3aby Sales Team
sales@mal3aby.app`
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, subject: 'x', body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MULTIPLE_PRODUCT_PITCHES_DUMPED')
  })

  it('rejects an email carrying an unsupported factual claim (groundingPassed=false)', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, groundingPassed: false })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('UNSUPPORTED_CLAIM')
    expect(result.gates.GROUNDING_PASS).toBe(false)
  })

  it('rejects low-confidence absence-of-evidence stated as certainty (English)', () => {
    const body = `Hi Pegasus Dreamland Club team,

We noticed your multi-sport complex in Giza includes a football academy, a tennis academy, and a gym under one operator, which is a great foundation for growth.

Your club currently manages bookings only by phone, which can be time-consuming for staff to coordinate across every field and program you run.

Mal3aby offers self-service online booking with a conflict-free availability engine to remove that friction and free up your team's time.

Would a quick 10-minute call work this week to discuss how this could fit your setup?

Mal3aby Sales Team
sales@mal3aby.app`
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, subject: 'x', body, lowConfidenceSignalKeys: ['phone_only_booking'] })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('CONFIDENCE_OVERSTATED')
  })

  it('rejects low-confidence absence-of-evidence stated as certainty (Arabic)', () => {
    const body = `مرحبًا فريق Pegasus Dreamland Club،

لاحظنا إن مجمعكم الرياضي في الجيزة بيضم أكاديمية كورة وأكاديمية تنس وجيم تحت إدارة واحدة، وده أساس ممتاز للتوسع.

تعتمدون حاليًا على الحجز عبر الهاتف فقط، وده ممكن ياخد وقت كبير من فريقكم في تنسيق كل الملاعب والبرامج.

ملعبي بيوفر حجز إلكتروني ذاتي مع نظام يمنع تعارض المواعيد، وده بيوفر وقت فريقكم.

هل تناسبكم مكالمة قصيرة ١٠ دقايق الأسبوع ده نتكلم فيها عن الموضوع أكتر؟

فريق ملعبي
sales@mal3aby.app`
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_AR, subject: 'x', body, lowConfidenceSignalKeys: ['phone_only_booking'] })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('CONFIDENCE_OVERSTATED')
  })

  it('accepts hedged/cautious language for the same low-confidence signal', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, lowConfidenceSignalKeys: ['phone_only_booking'] })
    // VALID_EMAIL_EN already uses "We couldn't find... so I wanted to ask" -- hedged, not asserted as fact.
    expect(result.gates.CONFIDENCE_LANGUAGE_PASS).toBe(true)
  })
})

describe('evaluateOutreachQuality — call task (phone_script / whatsapp_talking_points)', () => {
  it('accepts a valid, well-formed Arabic call script', () => {
    const result = evaluateOutreachQuality(VALID_CALL_TASK_AR)
    expect(result.status).toBe('APPROVAL_READY')
    expect(result.rejection_reasons).toEqual([])
  })

  it('rejects a call task with fewer than 2 discovery questions (only 1 question in the entire script)', () => {
    const body = `افتتاحية:
"معاك من فريق ملعبي، منصة لإدارة الأكاديميات والملاعب الرياضية."

أسئلة استكشافية:
1. إزاي بيتم تسجيل اللاعبين الجدد حاليًا؟

فرضية المشكلة: الاعتماد على فيسبوك فقط للتواصل قد يعني عمليات تسجيل يدوية.

القيمة المقترحة: نظام تسجيل وحضور واشتراكات في مكان واحد.

الرد على الاعتراضات:
- "عندنا نظام بالفعل": تمام، ملعبي بيبسط الموضوع أكتر من نظامكم الحالي.
- "ابعتلي معلومات": أكيد هبعتلك التفاصيل المناسبة لاحتياجك.
- "مش مهتم دلوقتي": مفهوم، هرجعلك بعد فترة لو الوقت يبقى أنسب.

الخطوة التالية: نرتب عرض قصير الأسبوع الجاي.`
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('INSUFFICIENT_DISCOVERY_QUESTIONS')
  })

  it('rejects a call task with no literal opening (only a topic label)', () => {
    const body = `افتتاحية: مقدمة عن ملعبي كمنصة لإدارة الأكاديميات.

أسئلة استكشافية:
1. إزاي بيتم تسجيل اللاعبين الجدد حاليًا؟
2. إزاي بتحصلوا الاشتراكات الشهرية؟

فرضية المشكلة: الاعتماد على فيسبوك فقط.

القيمة المقترحة: نظام واحد للتسجيل والحضور.

الرد على الاعتراضات:
- "عندنا نظام بالفعل": تمام، تحب أوريك الفرق؟
- "ابعتلي معلومات": هبعتلك تفاصيل مناسبة لاحتياجك.
- "مش مهتم دلوقتي": ممكن أرجعلك بعدين؟

الخطوة التالية: هل يناسبكم عرض قصير؟`
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_LITERAL_OPENING')
  })

  it('rejects a call task with no objection handling', () => {
    const body = VALID_CALL_TASK_AR.body.replace(/الرد على الاعتراضات:[\s\S]*?الخطوة التالية/, 'الخطوة التالية')
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_OBJECTION_HANDLING')
  })

  it('rejects a call task that is only talking-point scaffolding (the original pilot defect shape)', () => {
    const body = 'نقاط الحديث الهاتفي — CIC Arenas: 1) سؤال عن نظام الحجز الحالي 2) القيمة: حجز إلكتروني بدون تعارض 3) اقتراح ديمو'
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('MISSING_LITERAL_OPENING')
    expect(result.rejection_reasons).toContain('MISSING_OBJECTION_HANDLING')
  })

  it('rejects a call task with an unsupported claim (groundingPassed=false)', () => {
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, groundingPassed: false })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('UNSUPPORTED_CLAIM')
  })
})

describe('wordCount', () => {
  it('counts words correctly for English and Arabic text', () => {
    expect(wordCount('hello world')).toBe(2)
    expect(wordCount('مرحبا بكم في ملعبي')).toBe(4)
    expect(wordCount('  leading and trailing   spaces  ')).toBe(4)
  })
})
