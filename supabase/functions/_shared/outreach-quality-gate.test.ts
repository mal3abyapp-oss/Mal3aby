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

// ============================================================
// FINAL QUALITY-GATE HARDENING (2026-09-04, owner directive): 3 real
// defects the production regeneration exposed -- truncated generation,
// a stray output artifact, and evidence-strength overstatement -- were
// all incorrectly APPROVAL_READY under the prior gate. These tests lock
// in the fix: "Add regression tests proving rejection of: (1) provider
// completion stopped by token limit, (2) objection section cut mid-
// sentence, (3) structurally incomplete call script, (4) obvious
// isolated foreign-language artifact in an otherwise Arabic script,
// (5) public email evidence transformed into unsupported workflow
// claim. Also prove acceptance of: (6) legitimate English product/
// business names inside Arabic, (7) email addresses, (8) URLs,
// (9) properly completed Arabic call script, (10) properly completed
// English email."
// ============================================================
describe('evaluateOutreachQuality — generation completeness (Defect 1)', () => {
  it('1. rejects when the provider reports finishReason=length (token-limit termination), even if the text looks plausible', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, finishReason: 'length' })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('GENERATION_TRUNCATED')
    expect(result.gates.GENERATION_COMPLETENESS_PASS).toBe(false)
  })

  it('2. rejects a call script whose final objection response is cut off mid-sentence (the real Mr Soccer Academy defect shape)', () => {
    const body = VALID_CALL_TASK_AR.body.replace(
      /- "مش مهتم دلوقتي": مفهوم، ممكن أرجعلك بعد فترة لو الوقت يبقى أنسب؟/,
      '- "مش مهتم دلوقتي": مفهوم، هل أقدر أحدد معاكم ميعاد قصير خلال الأسبوع عشان أوريكم كيف ممكن النظام يوفر وقت وجهد، ولو لقيتوا إن فيه ف',
    )
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body, finishReason: 'length' })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('GENERATION_TRUNCATED')
  })

  it('3. rejects a structurally incomplete call script (ends on a dangling connector, no finishReason available)', () => {
    const body = `افتتاحية:
"معاك من فريق ملعبي، منصة لإدارة الأكاديميات والملاعب الرياضية. عندك دقيقتين أتكلم معاك؟"

أسئلة استكشافية:
1. إزاي بيتم تسجيل اللاعبين الجدد حاليًا؟
2. إزاي بتحصلوا الاشتراكات الشهرية؟

فرضية المشكلة: الاعتماد على فيسبوك فقط للتواصل قد يعني عمليات تسجيل يدوية.

القيمة المقترحة: نظام تسجيل وحضور واشتراكات في مكان واحد.

الرد على الاعتراضات:
- "عندنا نظام بالفعل": تمام، ملعبي بيتكامل أو بيبسط الموضوع أكتر، تحب أوريك الفرق في عرض قصير؟
- "ابعتلي معلومات": أكيد هبعتلك، بس عايز أفهم احتياجك الأول عشان
- "مش مهتم دلوقتي": مفهوم و`
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body, finishReason: undefined })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('GENERATION_TRUNCATED')
    expect(result.gates.GENERATION_COMPLETENESS_PASS).toBe(false)
  })

  it('9. accepts a properly completed Arabic call script with finishReason=stop', () => {
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, finishReason: 'stop' })
    expect(result.status).toBe('APPROVAL_READY')
    expect(result.gates.GENERATION_COMPLETENESS_PASS).toBe(true)
  })

  it('10. accepts a properly completed English email with finishReason=stop', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_EN, finishReason: 'stop' })
    expect(result.status).toBe('APPROVAL_READY')
    expect(result.gates.GENERATION_COMPLETENESS_PASS).toBe(true)
  })
})

describe('evaluateOutreachQuality — output integrity (Defect 2)', () => {
  it('4. rejects an obvious isolated Latin-script artifact inserted into otherwise-Arabic output (the real CIC Arenas "Alley" defect shape)', () => {
    const body = VALID_CALL_TASK_AR.body.replace(
      'ممكن أرجعلك بعد فترة لو الوقت يبقى أنسب؟',
      'ممكن أرجعلك بعد فترة لو الوقت يبقى أنسب؟ Alley',
    )
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('OUTPUT_INTEGRITY_FAILED')
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(false)
  })

  it('6. does NOT reject a legitimate English product/business name inside Arabic (Mal3aby, and the lead\'s own business name)', () => {
    const body = VALID_CALL_TASK_AR.body.replace('فريق ملعبي', 'فريق Mal3aby') + '\nنتكلم عن Mr Soccer Academy'
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body, businessName: 'Mr Soccer Academy' })
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(true)
    expect(result.rejection_reasons).not.toContain('OUTPUT_INTEGRITY_FAILED')
  })

  it('7. does NOT reject a legitimate email address inside Arabic output', () => {
    const body = VALID_CALL_TASK_AR.body + '\nفريق ملعبي\nsales@mal3aby.app'
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(true)
  })

  it('8. does NOT reject a legitimate URL inside Arabic output', () => {
    const body = VALID_CALL_TASK_AR.body + '\nزوروا https://mal3aby.app لمزيد من التفاصيل'
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(true)
  })

  it('does not reject an ALL-CAPS acronym (e.g. QR) inside Arabic output', () => {
    const body = VALID_CALL_TASK_AR.body.replace('نظام تسجيل وحضور واشتراكات', 'نظام تسجيل وحضور بتقنية QR واشتراكات')
    const result = evaluateOutreachQuality({ ...VALID_CALL_TASK_AR, body })
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(true)
  })

  it('never runs the foreign-script-artifact check on English-language output (nothing to flag)', () => {
    const result = evaluateOutreachQuality(VALID_EMAIL_EN)
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(true)
  })

  it('does NOT reject a legitimate Latin-script brand name (Gmail) inside Arabic output when hedged as an observation (live production regeneration finding, 2026-09-04)', () => {
    // Found live: Elmasry's regenerated draft correctly hedged the
    // Gmail-evidence claim ("لاحظنا... بريدكم الإلكتروني كـ Gmail
    // شخصي" -- an observation, not a workflow claim) but was then
    // wrongly rejected by OUTPUT_INTEGRITY for the word "Gmail" itself
    // -- a globally recognized email-service brand name, the same
    // legitimate-proper-noun shape as "Mal3aby", not a random inserted
    // artifact like the real "Alley" defect.
    const body = `أهلاً فريق Elmasry Football Academy،
لاحظنا نشاطكم المتواصل على إنستجرام لتدريب الأطفال في 6 أكتوبر وتوفر بريدكم الإلكتروني كـ Gmail شخصي.

هل تواجهون صعوبة في تنظيم تسجيل اللاعبين وإدارة بياناتهم عبر القنوات الحالية؟

مع خاصية إدارة تسجيل الأكاديمية من ملعبي، تقدروا تجمعوا بيانات اللاعبين وتسجيلاتهم في منصة موحدة وآمنة.

هل يناسبكم مكالمة قصيرة هذا الأسبوع؟

فريق ملعبي
sales@mal3aby.app`
    const result = evaluateOutreachQuality({
      ...VALID_EMAIL_AR,
      body,
      businessName: 'Elmasry Football Academy',
      contactMetadataOnlySignalKeys: ['public_email_contact'],
    })
    expect(result.gates.OUTPUT_INTEGRITY_PASS).toBe(true)
    expect(result.rejection_reasons).not.toContain('OUTPUT_INTEGRITY_FAILED')
  })
})

describe('evaluateOutreachQuality — evidence strength (Defect 3)', () => {
  it('5. rejects a public-email-existence signal transformed into an unsupported operational workflow claim (the real Elmasry defect shape)', () => {
    const body = `أهلاً فريق أكاديمية المصري لكرة القدم في الجيزة، لاحظت نشاطكم القوي على إنستجرام وفيسبوك مع الاعتماد على بريد جيميل شخصي لإدارة التواصل.

هل تواجهون صعوبة في جمع وتنسيق طلبات التسجيل لللاعبين بصورة منظمة؟

من خلال خاصية إدارة تسجيل الأكاديمية على منصة ملعبي، هتقدروا تستقبلوا طلبات التسجيل، تتبعها وتوثقها في نظام موحد.

هل يناسبكم مكالمة سريعة لمدة 15 دقيقة خلال هذا الأسبوع؟

فريق ملعبي
sales@mal3aby.app`
    const result = evaluateOutreachQuality({
      ...VALID_EMAIL_AR,
      subject: 'x',
      body,
      contactMetadataOnlySignalKeys: ['public_email_contact'],
    })
    expect(result.status).toBe('QUALITY_REJECTED')
    expect(result.rejection_reasons).toContain('EVIDENCE_STRENGTH_OVERSTATED')
    expect(result.gates.EVIDENCE_STRENGTH_PASS).toBe(false)
  })

  it('accepts the corrected, cautiously-hedged phrasing of the same observation ("the published contact method is Gmail" -- not a workflow claim)', () => {
    const body = `أهلاً فريق أكاديمية المصري لكرة القدم في الجيزة، لاحظنا أن وسيلة البريد المعلنة هي Gmail شخصي بدلاً من بريد رسمي للأكاديمية.

هل تواجهون صعوبة في جمع وتنسيق طلبات التسجيل لللاعبين بصورة منظمة؟

من خلال خاصية إدارة تسجيل الأكاديمية على منصة ملعبي، هتقدروا تستقبلوا طلبات التسجيل، تتبعها وتوثقها في نظام موحد.

هل يناسبكم مكالمة سريعة لمدة 15 دقيقة خلال هذا الأسبوع؟

فريق ملعبي
sales@mal3aby.app`
    const result = evaluateOutreachQuality({
      ...VALID_EMAIL_AR,
      subject: 'x',
      body,
      contactMetadataOnlySignalKeys: ['public_email_contact'],
    })
    expect(result.gates.EVIDENCE_STRENGTH_PASS).toBe(true)
    expect(result.rejection_reasons).not.toContain('EVIDENCE_STRENGTH_OVERSTATED')
  })

  it('never flags EVIDENCE_STRENGTH_OVERSTATED when no contact-metadata-only signal is present, even if similar wording appears', () => {
    const result = evaluateOutreachQuality({ ...VALID_EMAIL_AR, contactMetadataOnlySignalKeys: [] })
    expect(result.gates.EVIDENCE_STRENGTH_PASS).toBe(true)
  })
})
