import { describe, expect, it } from 'vitest'
import { dateRangeError } from './dateRange'
import { isUuid } from './ids'
import { asciiDigits, telHref } from './phone'
import { foldText, initials, isBlankText, leadingLetter } from './text'

describe('isUuid', () => {
  it('accepts canonical UUIDs in either case and nothing else', () => {
    expect(isUuid('7f0d1c0e-1111-4a5b-9c1d-000000000077')).toBe(true)
    expect(isUuid('7F0D1C0E-1111-4A5B-9C1D-000000000077')).toBe(true)
    expect(isUuid('7f0d1c0e-1111-4a5b-9c1d-00000000007')).toBe(false)
    expect(isUuid(' 7f0d1c0e-1111-4a5b-9c1d-000000000077')).toBe(false)
    expect(isUuid('')).toBe(false)
  })
})

describe('dateRangeError', () => {
  it('refuses only an end before the start', () => {
    expect(dateRangeError('2026-10-05', '2026-10-04')).toBe('Choose an end date on or after the start date.')
    expect(dateRangeError('2026-10-05', '2026-10-05')).toBeNull()
    expect(dateRangeError(null, '2026-10-04')).toBeNull()
    expect(dateRangeError('2026-10-05', null)).toBeNull()
  })
})

describe('telHref', () => {
  it('keeps the digits and a leading plus', () => {
    expect(telHref('+962 79 500 1002')).toBe('tel:+962795001002')
    expect(telHref('+962\u00A079\u202F500.1002')).toBe('tel:+962795001002')
    expect(telHref('(06) 555/0101')).toBe('tel:065550101')
  })

  it('dials Arabic-Indic and Extended Arabic-Indic digits, which the server accepts (SEC-33)', () => {
    expect(telHref('+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢')).toBe('tel:+962795001002')
    expect(telHref('٠٧٩ ٥٠٠ ١٠٠٢')).toBe('tel:0795001002')
    expect(telHref('۰۷۹ ۵۰۰ ۱۰۰۲')).toBe('tel:0795001002')
    expect(telHref('٠١٢٣٤٥٦٧٨٩')).toBe('tel:0123456789')
    expect(telHref('۰۱۲۳۴۵۶۷۸۹')).toBe('tel:0123456789')
    // Mixed scripts: every digit shown is dialled, in the order shown.
    expect(telHref('+962 79 ٥٠٠ 1003')).toBe('tel:+962795001003')
  })

  it('dials the main number of one with an extension, never the extension’s digits run on', () => {
    expect(telHref('(06) 555-0101 ext. 4')).toBe('tel:065550101')
    expect(telHref('06 555 0101 x12')).toBe('tel:065550101')
    expect(telHref('06 555 0101 EXT ٤٥')).toBe('tel:065550101')
  })

  it('gives no link for text that cannot be dialled as shown', () => {
    // Older rows (before the server's phone grammar): too few digits, words, a second number,
    // other scripts' digits, direction controls and marks.
    for (const phone of [
      '',
      '+',
      '12',
      '٠٧',
      '079 500 1002 or 1003',
      '079 500 1002 (mobile)',
      '𝟎𝟕𝟗 𝟓𝟎𝟎 𝟏𝟎𝟎𝟐',
      '+962 79 \u202E2001 005',
      '+962 79 \u20662001 005\u2069',
      '\u200E079 500 1002',
      '079\u200F 500 1002',
      '079\u061C 500 1002',
      '+962 79 500 1002 ext. 1234567',
      '079 + 500 1002',
      '079 500 1002\\',
    ]) {
      expect({ phone, href: telHref(phone) }).toEqual({ phone, href: null })
    }
  })
})

describe('asciiDigits', () => {
  it('maps both Arabic-Indic digit sets to ASCII and leaves everything else', () => {
    expect(asciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ 0123456789 +()-')).toBe('0123456789 0123456789 0123456789 +()-')
  })
})

describe('foldText', () => {
  it('ignores case and accents', () => {
    expect(foldText('Élodie MÜLLER')).toBe('elodie muller')
  })
})

describe('isBlankText', () => {
  it('counts white space and invisible format characters as nothing to read', () => {
    expect(isBlankText('')).toBe(true)
    expect(isBlankText('  \n\t')).toBe(true)
    // Zero-width space, word joiner and byte-order mark: trim() keeps the first two.
    expect(isBlankText('\u200b')).toBe(true)
    expect(isBlankText(' \u2060\ufeff ')).toBe(true)
    // A Hangul filler (the best-known blank name) and the blank braille cell render as nothing too.
    expect(isBlankText('\u3164')).toBe(true)
    expect(isBlankText('\u2800\u00ad')).toBe(true)
  })

  it('keeps text with anything to read, joiners inside words included', () => {
    expect(isBlankText('Late')).toBe(false)
    expect(isBlankText('\u200bLate')).toBe(false)
    // Persian with a zero-width non-joiner inside the word.
    expect(isBlankText('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645')).toBe(false)
  })
})

describe('initials', () => {
  const ZWNJ = '\u200c'

  it('takes the first letters of the first and last name parts of a Latin name', () => {
    expect(initials('Lina Haddad')).toBe('LH')
    expect(initials('omar')).toBe('O')
    expect(initials('  Amal  de la  Cruz ')).toBe('AC')
    expect(initials('')).toBe('?')
  })

  it('keeps two Arabic initials apart (no joined word) and skips the article of a surname', () => {
    // Joined, these read as the words «لا» ("no") and «ما», or as «أا».
    expect(initials('ليلى الحسن')).toBe(`ل${ZWNJ}ح`)
    expect(initials('محمد عبد الله')).toBe(`م${ZWNJ}ل`)
    expect(initials('أحمد الخطيب')).toBe(`أ${ZWNJ}خ`)
    expect(initials('سارة يوسف')).toBe(`س${ZWNJ}ي`)
    // A one-part name stays one letter; a bare article is a name part like any other.
    expect(initials('هند')).toBe('ه')
    expect(initials('رنا ال')).toBe(`ر${ZWNJ}ا`)
  })
})

describe('leadingLetter', () => {
  it('is the first letter or digit of a name, in upper case, after the Arabic article', () => {
    expect(leadingLetter('Sahara Sun Hotels')).toBe('S')
    expect(leadingLetter('  nova labs')).toBe('N')
    expect(leadingLetter('3M Gulf')).toBe('3')
    expect(leadingLetter('فنادق شمس الصحراء')).toBe('ف')
    // «البنك» is «ب»: the article says nothing of the name.
    expect(leadingLetter('البنك العربي')).toBe('ب')
    // A bare article is a word like any other; a name that only looks like one keeps its letter.
    expect(leadingLetter('ال')).toBe('ا')
    expect(leadingLetter('ألمانيا')).toBe('أ')
  })

  it('passes over what is no letter, and is empty for a name without one', () => {
    expect(leadingLetter('“Élan” & Co')).toBe('É')
    expect(leadingLetter('& — Partners')).toBe('P')
    expect(leadingLetter('***')).toBe('')
    expect(leadingLetter('')).toBe('')
  })
})
