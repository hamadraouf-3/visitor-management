import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, getErrorMessage } from '../api/client'
import { i18n } from './index'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

function apiError(status: number, code: string, message: string) {
  return new ApiError({ status, code, message })
}

describe('error messages in the UI language (F10-6)', () => {
  it('shows the server message in English, also a more specific one than the code default', () => {
    expect(getErrorMessage(apiError(409, 'CONFLICT', 'A department with this name already exists.'))).toBe(
      'A department with this name already exists.',
    )
    expect(getErrorMessage(apiError(410, 'PASS_EXPIRED', 'This visitor pass has expired.'))).toBe('This visitor pass has expired.')
  })

  it('translates by error code in Arabic, whatever the English message says', async () => {
    await i18n.changeLanguage('ar')
    expect(getErrorMessage(apiError(410, 'PASS_EXPIRED', 'This visitor pass has expired.'))).toBe('انتهت صلاحية بطاقة الزيارة هذه.')
    expect(getErrorMessage(apiError(409, 'CONFLICT', 'A department with this name already exists.'))).toBe('هذه القيمة مستخدمة بالفعل.')
    expect(getErrorMessage(apiError(0, 'NETWORK_ERROR', 'We could not reach the server.'))).toBe(
      'تعذّر الوصول إلى الخادم. تحقّق من اتصالك وحاول مرة أخرى.',
    )
  })

  it('says the service is unavailable for a gateway page, and keeps the message of an unknown code', async () => {
    await i18n.changeLanguage('ar')
    expect(getErrorMessage(apiError(503, 'UNEXPECTED_RESPONSE', 'The service is temporarily unavailable.'))).toBe(
      'الخدمة غير متاحة مؤقتًا. يُرجى المحاولة بعد قليل.',
    )
    expect(getErrorMessage(apiError(500, 'UNEXPECTED_RESPONSE', 'Something went wrong. Please try again.'))).toBe(
      'حدث خطأ ما. يُرجى المحاولة مرة أخرى.',
    )
    expect(getErrorMessage(apiError(418, 'SOMETHING_NEW', 'A message from a newer API.'))).toBe('A message from a newer API.')
  })

  it('has a generic message for anything that is not an API error', async () => {
    expect(getErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.')
    await i18n.changeLanguage('ar')
    expect(getErrorMessage(new Error('boom'))).toBe('حدث خطأ ما. يُرجى المحاولة مرة أخرى.')
  })
})
