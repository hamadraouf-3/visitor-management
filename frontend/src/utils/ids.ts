const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a UUID in its canonical textual form (every ID is a UUID, §4). */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
