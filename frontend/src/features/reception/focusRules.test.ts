import { afterEach, describe, expect, it } from 'vitest'
import { isEditable, isFocusIdle, isModalOpen, isPassCharacterKey, mayMoveFocusInto } from './focusRules'

afterEach(() => {
  document.body.innerHTML = ''
})

function key(value: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>> = {}) {
  return { key: value, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...modifiers }
}

describe('isFocusIdle', () => {
  it('is true for no focus, the body, and the layout’s landing targets', () => {
    document.body.innerHTML = '<main id="main-content" tabindex="-1"><h1 tabindex="-1">Reception</h1><button>Go</button></main>'
    expect(isFocusIdle(null)).toBe(true)
    expect(isFocusIdle(document.body)).toBe(true)
    expect(isFocusIdle(document.getElementById('main-content'))).toBe(true)
    expect(isFocusIdle(document.querySelector('h1'))).toBe(true)
    expect(isFocusIdle(document.querySelector('button'))).toBe(false)
  })
})

describe('isEditable', () => {
  it('is true for controls that take text, false for buttons and links', () => {
    document.body.innerHTML = `
      <input id="text" /><input id="search" type="search" /><input id="check" type="checkbox" />
      <textarea id="area"></textarea><select id="select"></select><button id="button">x</button><a id="link" href="#">x</a>`
    for (const id of ['text', 'search', 'area', 'select']) expect(isEditable(document.getElementById(id))).toBe(true)
    for (const id of ['check', 'button', 'link']) expect(isEditable(document.getElementById(id))).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})

describe('isPassCharacterKey', () => {
  it('is true for the characters of a pass, not for space, named keys or shortcuts', () => {
    for (const value of ['a', 'Z', '7', '-', '_', ':', '/', '#', '.']) expect(isPassCharacterKey(key(value))).toBe(true)
    for (const value of [' ', 'Enter', 'Tab', 'ArrowDown', 'Escape']) expect(isPassCharacterKey(key(value))).toBe(false)
    expect(isPassCharacterKey(key('v', { ctrlKey: true }))).toBe(false)
    expect(isPassCharacterKey(key('v', { metaKey: true }))).toBe(false)
    expect(isPassCharacterKey(key('a', { isComposing: true }))).toBe(false)
  })
})

describe('mayMoveFocusInto', () => {
  it('allows moving focus from nowhere or from inside the scanner only, and never under a dialog', () => {
    document.body.innerHTML = '<div id="scanner"><input id="pass" /></div><input id="search" /><div id="dialog"></div>'
    const scanner = document.getElementById('scanner')
    expect(mayMoveFocusInto(scanner)).toBe(true)

    document.getElementById('pass')?.focus()
    expect(mayMoveFocusInto(scanner)).toBe(true)

    document.getElementById('search')?.focus()
    expect(mayMoveFocusInto(scanner)).toBe(false)

    document.getElementById('pass')?.focus()
    document.getElementById('dialog')?.setAttribute('aria-modal', 'true')
    expect(isModalOpen()).toBe(true)
    expect(mayMoveFocusInto(scanner)).toBe(false)
  })
})
