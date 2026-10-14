import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CAMERA_ERRORS } from '../../scanner/cameraErrors'
import type { CameraControls } from '../../scanner/useCameraStream'
import { CameraView, type CameraViewProps } from './CameraView'

function camera(overrides: Partial<CameraControls> = {}): CameraControls {
  return {
    status: 'live',
    error: null,
    stream: null,
    devices: [],
    deviceId: null,
    start: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    selectDevice: vi.fn<(deviceId: string) => void>(),
    ...overrides,
  }
}

function renderView(props: Partial<CameraViewProps> = {}) {
  const user = userEvent.setup()
  const view = render(
    <CameraView
      camera={camera()}
      phase="scanning"
      setVideo={() => {}}
      {...props}
    />,
  )
  return { ...view, user }
}

describe('CameraView', () => {
  it('asks to point the camera at the code, with no "hold it steady" note however long nothing is read', async () => {
    vi.useFakeTimers()
    try {
      renderView()
      expect(screen.getByText('Point the camera at the visitor’s QR code')).toBeInTheDocument()
      // Only camera problems are spoken, not the label that changes with every scan.
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
      // An idle desk (nobody at the camera) never turns the label into advice (the user's request 8).
      await vi.advanceTimersByTimeAsync(60_000)
      expect(screen.getByText('Point the camera at the visitor’s QR code')).toBeInTheDocument()
      expect(screen.queryByText(/Hold the code steady|Not reading/)).toBeNull()
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says scanning is paused while a result is shown', () => {
    renderView({ phase: 'result' })
    expect(screen.getByText('Scanning paused')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('offers a camera picker only when there is more than one camera', async () => {
    const selectDevice = vi.fn<(deviceId: string) => void>()
    const { user } = renderView({
      camera: camera({
        deviceId: 'rear',
        devices: [
          { deviceId: 'rear', label: 'Back camera' },
          { deviceId: 'front', label: 'Front camera' },
        ],
        selectDevice,
      }),
    })
    const picker = screen.getByRole('combobox', { name: 'Camera' })
    expect(picker).toHaveValue('rear')
    await user.selectOptions(picker, 'front')
    expect(selectDevice).toHaveBeenCalledWith('front')
  })

  it('shows no picker for a single camera', () => {
    renderView({ camera: camera({ devices: [{ deviceId: 'rear', label: 'Back camera' }] }) })
    expect(screen.queryByRole('combobox', { name: 'Camera' })).toBeNull()
  })

  it('shows an error with "Try again" only where it can help', async () => {
    const start = vi.fn<() => void>()
    const { user, rerender } = renderView({ camera: camera({ status: 'error', error: CAMERA_ERRORS['no-camera'], start }) })
    expect(screen.getByText('No camera found')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No camera found. Connect a camera, then select Try again.')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(start).toHaveBeenCalledOnce()

    rerender(
      <CameraView
        camera={camera({ status: 'error', error: CAMERA_ERRORS['insecure-context'] })}
        phase="idle"
        setVideo={() => {}}
      />,
    )
    expect(screen.getByText('The camera needs a secure connection')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('gives every control on the preview the two-tone focus ring that shows on any picture', () => {
    // The ring of "Turn camera off" lies on the live picture: a white ring alone was 1.14:1 on a
    // bright frame. The utility (index.css) draws it white between dark bands.
    const { rerender } = renderView()
    const preview = screen.getByRole('button', { name: 'Turn camera off' }).closest('.focus-ring-on-media')
    expect(preview).not.toBeNull()
    expect(preview).toContainElement(screen.getByRole('button', { name: 'Turn camera off' }))

    rerender(<CameraView camera={camera({ status: 'idle' })} phase="idle" setVideo={() => {}} />)
    expect(screen.getByRole('button', { name: 'Start camera' }).closest('.focus-ring-on-media')).toBe(preview)
    rerender(<CameraView camera={camera({ status: 'error', error: CAMERA_ERRORS['no-camera'] })} phase="idle" setVideo={() => {}} />)
    expect(screen.getByRole('button', { name: 'Try again' }).closest('.focus-ring-on-media')).toBe(preview)
  })

  it('turns the camera off on request', async () => {
    const stop = vi.fn<() => void>()
    const { user } = renderView({ camera: camera({ stop }) })
    await user.click(screen.getByRole('button', { name: 'Turn camera off' }))
    expect(stop).toHaveBeenCalledOnce()
  })
})
