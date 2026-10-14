/**
 * Temporary passwords for new accounts (D-11). Generated in the browser with the Web Crypto
 * random generator, never sent anywhere but the create request.
 *
 * Shape: four groups of five characters joined by hyphens ("k7Hq2-mPx9z-4tRwc-Yb3nD"), 23
 * characters, about 116 bits of entropy. The alphabet leaves out characters that are easily
 * confused when read aloud or copied by hand (0/O/o, 1/l/I), because the administrator usually
 * passes the password on by voice or on paper.
 */
export const TEMPORARY_PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const GROUPS = 4
const GROUP_LENGTH = 5

/** Fills the array with random bytes (the Web Crypto generator; tests pass a fixed sequence). */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void

const cryptoRandom: RandomSource = (bytes) => {
  crypto.getRandomValues(bytes)
}

/** A uniformly random index below `size`, without the modulo bias of `byte % size`. */
function randomIndex(size: number, random: RandomSource): number {
  const limit = 256 - (256 % size)
  const byte = new Uint8Array(1)
  for (;;) {
    random(byte)
    const value = byte[0]!
    if (value < limit) return value % size
  }
}

export function generateTemporaryPassword(random: RandomSource = cryptoRandom): string {
  const groups: string[] = []
  for (let group = 0; group < GROUPS; group += 1) {
    let text = ''
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      text += TEMPORARY_PASSWORD_ALPHABET[randomIndex(TEMPORARY_PASSWORD_ALPHABET.length, random)]
    }
    groups.push(text)
  }
  return groups.join('-')
}
