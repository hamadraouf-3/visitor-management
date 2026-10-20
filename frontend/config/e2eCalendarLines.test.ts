// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lineProblems } from '../e2e/support/icalendar.ts'

/*
 * The E2E suite's check of an `.ics`'s lines (`e2e/support/icalendar.ts`, Phase 14, F14-23), checked here
 * itself: it reads the file's octets, so a character cut in two by a fold is found, which text read
 * first would have turned into U+FFFD and hidden.
 */

const encoder = new TextEncoder()
/** Octets from text and raw bytes. */
const octets = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => Buffer.from(typeof part === 'string' ? encoder.encode(part) : part)))

describe('lineProblems (the E2E suite’s .ics check)', () => {
  it('passes a valid object: CRLF lines of at most 75 octets, Arabic whole', () => {
    expect(lineProblems(octets('BEGIN:VCALENDAR\r\nSUMMARY:زيارة\r\nX:', 'a'.repeat(73), '\r\nEND:VCALENDAR\r\n'))).toEqual([])
  })

  it('finds a character a fold cut in two, which the same octets read as text hide', () => {
    // «ز» is D8 B2; an emoji is four octets.
    const letter = octets('SUMMARY:ab', [0xd8], '\r\n ', [0xb2], 'cd\r\n')
    expect(lineProblems(letter)).toEqual(['line 1 is not UTF-8 on its own', 'line 2 is not UTF-8 on its own'])
    expect(lineProblems(octets('SUMMARY:', [0xf0, 0x9f], '\r\n ', [0x98, 0x80], '\r\n'))).toEqual(['line 1 is not UTF-8 on its own', 'line 2 is not UTF-8 on its own'])
    expect(lineProblems(Buffer.from(letter.toString('utf8'), 'utf8'))).toEqual([])
    // Bytes that are no UTF-8 at all: an overlong form, an encoded surrogate.
    expect(lineProblems(octets('X:', [0xc0, 0xaf], '\r\n'))).toEqual(['line 1 is not UTF-8 on its own'])
    expect(lineProblems(octets('X:', [0xed, 0xa0, 0x80], '\r\n'))).toEqual(['line 1 is not UTF-8 on its own'])
  })

  it('finds a line longer than 75 octets, and a line end that is not CRLF, wherever it is', () => {
    expect(lineProblems(octets('X:', 'a'.repeat(74), '\r\n'))).toEqual(['line 1 has 76 octets'])
    expect(lineProblems(octets('A:1\nB:2\r\n'))).toEqual(['a line ends without CRLF'])
    expect(lineProblems(octets('\nA:1\r\n'))).toEqual(['a line ends without CRLF'])
    expect(lineProblems(octets('A:1\r\nB:2\r'))).toEqual(['the last line has no CRLF', 'a line ends without CRLF'])
    expect(lineProblems(octets('A:1\r\nB:2'))).toEqual(['the last line has no CRLF'])
  })

  it('reads a view into a larger buffer from its own start (a file read into a shared pool)', () => {
    const pool = octets('JUNK\nJUNK\n', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    expect(lineProblems(pool.subarray(10))).toEqual([])
  })
})
