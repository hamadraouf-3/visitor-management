import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { textWithParts } from '../utils/text'
import { i18n } from './index'
import { withParts } from './withParts'

const sentence = (markers: { count: string; link: string }) => `Before ${markers.count} middle ${markers.link} after.`

describe('withParts', () => {
  it('places each element where the language’s sentence puts it', () => {
    const { container } = render(<p>{withParts(sentence, { count: <strong>3 visits</strong>, link: <a href="/x">the list</a> })}</p>)
    expect(container.querySelector('p')?.innerHTML).toBe('Before <strong>3 visits</strong> middle <a href="/x">the list</a> after.')
  })

  it('lets Arabic write «و» against the next part, and starts or ends with a part without empty pieces', () => {
    const parts = withParts((markers) => `${markers.a} و${markers.b}`, { a: 'أ', b: 'ب' })
    expect(parts).toHaveLength(3)
    const { container } = render(<p>{parts}</p>)
    expect(container.textContent).toBe('أ وب')
  })

  it('works with a catalog sentence in either language', async () => {
    await i18n.changeLanguage('ar')
    const { container } = render(<p>{withParts((markers) => i18n.t('common:print.generated', { when: markers.when, zone: markers.zone }), { when: <time>9:00</time>, zone: 'UTC' })}</p>)
    expect(container.querySelector('time')).toHaveTextContent('9:00')
    expect(container.textContent).toBe('تاريخ الإنشاء: 9:00، UTC.')
  })
})

describe('textWithParts', () => {
  it('splits a sentence around its parts for plain-text and e-mail use', () => {
    const email = { email: 'lina@example.com' }
    expect(textWithParts((markers) => `Send it to ${markers.email} today.`, { email })).toEqual(['Send it to ', email, ' today.'])
  })
})
