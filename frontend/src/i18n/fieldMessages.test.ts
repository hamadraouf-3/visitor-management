import { describe, expect, it } from 'vitest'
import contract from '../types/backend-contract.json'
import { resources } from './resources'
import { fieldCodeValues, translateFieldError } from './fieldMessages'

const tooLong = (max: number) => translateFieldError(`Enter at most ${max} characters.`, { code: 'too_long', params: { max } }, 'ar')
const variables = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]!)

/*
 * A 422's field errors come with a message written in English and a code with its parameters
 * (backend B10-18): English keeps the server's words, Arabic shows the catalog's text for the code.
 */
describe('translateFieldError', () => {
  it('keeps the server’s words in English, code or not', () => {
    expect(translateFieldError('Email address is too long.', { code: 'too_long', params: { max: 320 } }, 'en')).toBe('Email address is too long.')
    expect(translateFieldError('Enter a valid value.', undefined, 'en')).toBe('Enter a valid value.')
  })

  it('shows the catalog’s text for the code in Arabic, whatever the English wording', () => {
    expect(translateFieldError('This password is too common. Choose a less predictable password.', { code: 'password_common', params: {} }, 'ar')).toBe(
      'كلمة المرور هذه شائعة جدًا. اختر كلمة مرور يصعب توقّعها.',
    )
    // Reworded on the server: the code still says what it is.
    expect(translateFieldError('Please fill this in.', { code: 'required', params: {} }, 'ar')).toBe('هذا الحقل مطلوب.')
    expect(translateFieldError('Choose a password that is different from your current password.', { code: 'password_unchanged', params: {} }, 'ar')).toBe(
      'اختر كلمة مرور مختلفة عن كلمة مرورك الحالية.',
    )
    // Phase 10 shared contract A: an employee invites in their own name only.
    const ownHost = 'You can only invite visitors you host yourself.'
    expect(translateFieldError(ownHost, { code: 'host_must_be_self', params: {} }, 'ar')).toBe('يمكنك دعوة الزوار باسمك فقط.')
    expect(translateFieldError(ownHost, { code: 'host_must_be_self', params: {} }, 'en')).toBe(ownHost)
  })

  it('fills in the parameters, with the Arabic plural of the counted ones', () => {
    expect(tooLong(1)).toBe('أدخل حرفًا واحدًا على الأكثر.')
    expect(tooLong(2)).toBe('أدخل حرفين على الأكثر.')
    expect(tooLong(5)).toBe('أدخل 5 أحرف على الأكثر.')
    expect(tooLong(120)).toBe('أدخل 120 حرفًا على الأكثر.')
    expect(tooLong(101)).toBe('أدخل 101 حرف على الأكثر.')
    expect(tooLong(320)).toBe('أدخل 320 حرفًا على الأكثر.')
    expect(tooLong(12)).toBe('أدخل 12 حرفًا على الأكثر.')
    expect(translateFieldError('Password must be at least 12 characters.', { code: 'too_short', params: { min: 12 } }, 'ar')).toBe(
      'أدخل 12 حرفًا على الأقل.',
    )
    expect(translateFieldError('A visit can last at most 24 hours.', { code: 'visit_too_long', params: { max_hours: 24 } }, 'ar')).toBe(
      'لا يمكن أن تتجاوز مدة الزيارة 24 ساعة.',
    )
    expect(translateFieldError('Choose a range of at most 366 days.', { code: 'range_too_long', params: { max_days: 366 } }, 'ar')).toBe(
      'اختر نطاقًا لا يزيد على 366 يومًا.',
    )
    expect(
      translateFieldError(
        "This visitor's pass for a visit becomes valid at 14:30 today. Check them in on that visit from then (Expected), after verifying their ID.",
        { code: 'walk_in_before_window', params: { time: '14:30' } },
        'ar',
      ),
    ).toContain('الساعة 14:30 اليوم')
    expect(
      translateFieldError('This visitor has 7 scheduled visits. …', { code: 'too_many_reinvitations', params: { count: 7, limit: 5 } }, 'ar'),
    ).toBe(
      'لهذا الزائر 7 زيارات مجدولة. يؤدي البريد الجديد إلى إرسال دعوة جديدة لكل منها، ولا يمكن إرسال أكثر من 5 دعوة لكل مستخدم خلال 24 ساعة: ألغِ بعض هذه الزيارات أولًا. ويؤدي حذف البريد الإلكتروني إلى سحب كل بطاقاته دفعة واحدة.',
    )
    expect(translateFieldError('Enter a value of at most 600.', { code: 'too_large', params: { max: 600 } }, 'ar')).toBe('أدخل قيمة لا تزيد على 600.')
    expect(translateFieldError("Choose one of: 'ar' or 'en'.", { code: 'invalid_choice', params: { choices: ['ar', 'en'] } }, 'ar')).toBe(
      'اختر إحدى القيم: ar، en.',
    )
  })

  it('keeps the server’s words for a code it does not know, a field without a code, or a count that did not arrive', () => {
    expect(translateFieldError('A brand-new rule from a newer server.', { code: 'brand_new_rule', params: {} }, 'ar')).toBe(
      'A brand-new rule from a newer server.',
    )
    expect(translateFieldError('This field is required.', undefined, 'ar')).toBe('This field is required.')
    expect(translateFieldError('Enter at most 500 characters.', { code: 'too_long', params: {} }, 'ar')).toBe('Enter at most 500 characters.')
  })
})

describe('fieldCodeValues', () => {
  it('joins a list and passes the counting parameter as the plural count', () => {
    expect(fieldCodeValues({ code: 'invalid_choice', params: { choices: ['ar', 'en'] } }, 'en')).toEqual({ choices: 'ar, en' })
    expect(fieldCodeValues({ code: 'too_far_ahead', params: { max_days: 365 } }, 'ar')).toEqual({ max_days: 365, count: 365 })
    expect(fieldCodeValues({ code: 'too_many_reinvitations', params: { count: 3, limit: 5 } }, 'ar')).toEqual({ count: 3, limit: 5 })
  })

  it('gives a text the Latin example the server sends no parameter for (UX review M3)', () => {
    // An Arabic text holds no Latin words: the example of a variable is a value, in both languages.
    expect(fieldCodeValues({ code: 'invalid_placeholder', params: {} }, 'ar')).toEqual({ example: '{visitor_name}' })
    expect(translateFieldError('Write a variable as its name in braces.', { code: 'invalid_placeholder', params: {} }, 'ar')).toBe(
      'اكتب المتغيّر بين حاصرتين، هكذا: {visitor_name}. الحاصرتان للمتغيّرات فقط.',
    )
    // A newer server's own example wins.
    expect(fieldCodeValues({ code: 'invalid_placeholder', params: { example: '{date}' } }, 'en')).toEqual({ example: '{date}' })
  })

  it('shows the e-mail texts’ two newer codes in Arabic, the count with its plural (B11-40)', () => {
    expect(translateFieldError('{purpose} cannot be used in this text.', { code: 'placeholder_not_allowed', params: { name: 'purpose' } }, 'ar')).toBe(
      'لا يمكن استخدام «purpose» في هذا النص.',
    )
    expect(translateFieldError('Use {purpose} at most 3 times in this text.', { code: 'placeholder_repeated', params: { name: 'purpose', max: 3 } }, 'ar')).toBe(
      'استخدم «purpose» 3 مرات على الأكثر في هذا النص.',
    )
    expect(fieldCodeValues({ code: 'placeholder_repeated', params: { name: 'purpose', max: 3 } }, 'en')).toEqual({ name: 'purpose', max: 3, count: 3 })
    // English keeps the server's own words.
    expect(translateFieldError('Use {purpose} at most 3 times in this text.', { code: 'placeholder_repeated', params: { name: 'purpose', max: 3 } }, 'en')).toBe(
      'Use {purpose} at most 3 times in this text.',
    )
  })

  it('finds the variables of a text (the check below read none: its pattern had lost its backslashes)', () => {
    expect(variables('Enter {{ min }} to {{max}}.')).toEqual(['min', 'max'])
  })
})

describe('the field error catalog', () => {
  type FieldTexts = Record<string, string>
  const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
  const codes = contract.field_error_codes as Record<string, string[]>

  it.each(['en', 'ar'] as const)('%s: has a text for exactly the codes of the contract', (language) => {
    const texts = resources[language].errors.fieldCodes as FieldTexts
    const catalogCodes = new Set(Object.keys(texts).map((key) => key.replace(PLURAL_SUFFIX, '')))
    expect([...catalogCodes].toSorted()).toEqual(Object.keys(codes).toSorted())
  })

  it.each(['en', 'ar'] as const)('%s: each text uses only its code’s parameters, the counted ones as the plural count', (language) => {
    const texts = resources[language].errors.fieldCodes as FieldTexts
    const problems: string[] = []
    for (const [key, text] of Object.entries(texts)) {
      const plural = PLURAL_SUFFIX.test(key)
      const code = key.replace(PLURAL_SUFFIX, '')
      const params = codes[code] ?? []
      const values = fieldCodeValues({ code, params: Object.fromEntries(params.map((name) => [name, 1])) }, language)
      // A counted code's form may say its number in words ("ساعتين") instead of {{count}}.
      if (plural !== 'count' in values) problems.push(`${key}: plural forms ${plural ? 'without' : 'missing for'} a counted code`)
      for (const name of variables(text)) if (!(name in values)) problems.push(`${key}: {{${name}}} is not a parameter of ${code}`)
    }
    expect(problems).toEqual([])
  })
})
