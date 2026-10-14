import { currentLanguage, INTL_LOCALES, type Language } from '../i18n'

/** Direction marks some `Intl` outputs carry (Arabic percentages); the context lays the text out. */
const BIDI_MARKS = /[\u200E\u200F\u061C]/g

const numberFormats = new Map<string, Intl.NumberFormat>()

function numberFormat(language: Language, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${language}|${JSON.stringify(options)}`
  let formatter = numberFormats.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(INTL_LOCALES[language], options)
    numberFormats.set(key, formatter)
  }
  return formatter
}

/**
 * "1,284": grouped thousands, with Latin digits in both languages (F10-5), like every other
 * number the app shows (times, codes, phone numbers).
 */
export function formatCount(value: number, language: Language = currentLanguage()): string {
  return numberFormat(language).format(value)
}

/** A number with the given `Intl` options (fraction digits, units), Latin digits in both languages. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, language: Language = currentLanguage()): string {
  return numberFormat(language, options).format(value).replace(BIDI_MARKS, '')
}

/** A ratio as a percentage: 0.125 → "12.5%" (at most one decimal). */
export function formatPercent(ratio: number, language: Language = currentLanguage()): string {
  return formatNumber(ratio, { style: 'percent', maximumFractionDigits: 1 }, language)
}
