export type ClassValue = string | false | null | undefined

/** Joins truthy class names. Components keep variant maps explicit instead of merging utilities. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}
