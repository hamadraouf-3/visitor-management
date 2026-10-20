/** How long a file's address lives after its download starts: long enough for any browser to read it (as FileSaver.js waits). */
const URL_LIFETIME_MS = 40_000

/**
 * Saves text made in the browser as a file (an `.ics`): an object URL of a Blob of `type`, followed through
 * a link with `download`, from the person's own click (call it synchronously in the click's handler).
 *
 * On iPhone and iPad, Safari opens a Blob typed `text/calendar` as its "Add to Calendar" sheet, where an
 * untyped one goes to Files; a `data:` address, the older way, opens nothing since iOS 26.5 or 26.6 (F14-6).
 */
export function downloadTextFile(content: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS)
}
