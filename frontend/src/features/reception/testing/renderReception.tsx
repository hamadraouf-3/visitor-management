import { act } from '@testing-library/react'
import { onTestFinished, vi } from 'vitest'
import { installFakeCamera, type FakeCamera, type FakeCameraOptions } from '../../../scanner/testing/fakeCamera'
import { createQrDetector, type QrDetector } from '../../../scanner/zxing'
import { jsonResponse, mockApi, type RouteHandler } from '../../../test/api'
import { renderRoutes } from '../../../test/render'
import ReceptionPage from '../ReceptionPage'
import { makeSettings, makeToday, RECEPTIONIST } from './receptionFixtures'

/** What the fake camera "sees": a code (raw text) or nothing, changeable during the test. */
export interface FakeScene {
  show: (rawValue: string | null) => void
  detect: ReturnType<typeof vi.fn<QrDetector['detect']>>
}

function installScene(): FakeScene {
  let current: string | null = null
  const detect = vi.fn<QrDetector['detect']>(() => Promise.resolve(current ? [{ rawValue: current }] : []))
  vi.mocked(createQrDetector).mockResolvedValue({ engine: 'zxing', detector: { detect } })
  return {
    show: (rawValue) => {
      current = rawValue
    },
    detect,
  }
}

/** `(pointer: coarse)` matches (a touch screen); other queries do not. */
export function stubCoarsePointer(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn<(query: string) => Pick<MediaQueryList, 'matches'> & { addEventListener: () => void; removeEventListener: () => void }>((query) => ({
      matches: query === '(pointer: coarse)',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

export interface RenderReceptionOptions {
  routes?: Record<string, RouteHandler>
  camera?: FakeCameraOptions
  initialEntry?: string
}

/**
 * Renders the reception page (the lazy route's component, directly) as a receptionist, with a
 * fake camera and a scene the decoder reads. Returns the API recorder, the router and the scene.
 */
export function renderReception({ routes = {}, camera = {}, initialEntry = '/reception' }: RenderReceptionOptions = {}) {
  const fakeCamera: FakeCamera = installFakeCamera(camera)
  onTestFinished(() => fakeCamera.restore())
  const scene = installScene()
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(RECEPTIONIST),
    'GET /reception/today': () => jsonResponse(makeToday()),
    'GET /company/settings': () => jsonResponse(makeSettings()),
    ...routes,
  })
  const view = renderRoutes([{ path: '/reception', element: <ReceptionPage /> }], { initialEntries: [initialEntry] })
  return { ...api, ...view, camera: fakeCamera, scene }
}

/** Requests to one endpoint, in order. */
export function requestsTo<R extends { method: string; path: string }>(requests: R[], method: string, path: string): R[] {
  return requests.filter((request) => request.method === method && request.path === path)
}

/** Lets pending promises and React updates settle (no timers are advanced). */
export async function settle(): Promise<void> {
  await act(async () => {})
}
