// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * The Visitor Journey shows no picture and touches no camera (the contract's hard rule: no image capture,
 * no camera access, no images anywhere in this feature; the cameras are names and the provider's IDs). Every
 * source of the feature, of its administration and of the platform owner's switch is read for an image,
 * a video, a canvas, a picture element or a camera API.
 */

const SOURCE = fileURLToPath(new URL('../..', import.meta.url))
const FEATURE_PATHS = ['features/journey', 'features/admin/tracking', 'features/platform/CompanyTrackingCard.tsx', 'api/tracking.ts']
const FORBIDDEN = /<img\b|<video\b|<canvas\b|<picture\b|getUserMedia|mediaDevices|ImageCapture|createObjectURL|\.toDataURL\(|new Image\(/

function sources(path: string): string[] {
  const full = join(SOURCE, path)
  if (/\.tsx?$/.test(full)) return [full]
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(path, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(full, entry.name)] : []))
}

describe('the Visitor Journey shows no picture and touches no camera', () => {
  it('has none in any of its sources', () => {
    const files = FEATURE_PATHS.flatMap(sources)
    expect(files.length).toBeGreaterThan(15)
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => (FORBIDDEN.test(line) ? [`${relative(SOURCE, file).replaceAll('\\', '/')}:${index + 1} ${line.trim()}`] : [])),
    )
    expect(found).toEqual([])
  })
})
