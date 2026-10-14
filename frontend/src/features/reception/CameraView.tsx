import { Camera, CameraOff, LoaderCircle, RotateCw, ScanLine } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Field } from '../../components/ui/Field'
import { Select } from '../../components/ui/Select'
import type { CameraControls } from '../../scanner/useCameraStream'
import { cn } from '../../utils/cn'
import { isFocusLost } from '../../utils/focus'
import type { ScannerPhase } from './scanFlow'

export interface CameraViewProps {
  camera: CameraControls
  phase: ScannerPhase
  setVideo: (video: HTMLVideoElement | null) => void
}

/**
 * Direction C's square frame where the code should be held: four rounded corners in mawdoo3's
 * turquoise, centred on the picture (decorative). `left-1/2` with its translation centres it in
 * either direction; the corners are symmetric.
 */
function ScanFrame() {
  const corner = 'absolute size-12 border-accent-strong'
  return (
    <div aria-hidden="true" className="pointer-events-none absolute top-[46%] left-1/2 aspect-square h-[58%] -translate-x-1/2 -translate-y-1/2">
      <span className={cn(corner, 'start-0 top-0 rounded-ss-[1.75rem] border-s-[5px] border-t-[5px]')} />
      <span className={cn(corner, 'end-0 top-0 rounded-se-[1.75rem] border-e-[5px] border-t-[5px]')} />
      <span className={cn(corner, 'start-0 bottom-0 rounded-es-[1.75rem] border-s-[5px] border-b-[5px]')} />
      <span className={cn(corner, 'end-0 bottom-0 rounded-ee-[1.75rem] border-e-[5px] border-b-[5px]')} />
    </div>
  )
}

/**
 * Shares the grid cell with the 4:3 spacer, so a long message makes the box taller instead of
 * being cut off. `compact` (the strip while a pass is handled, below lg) puts it on one line and
 * leaves out what marks `data-full-only`.
 */
function Overlay({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div
      className={cn(
        'relative col-start-1 row-start-1 flex flex-col items-center justify-center gap-3 p-4 text-center text-on-media',
        compact && 'max-lg:flex-row max-lg:py-2 max-lg:[&_[data-full-only]]:hidden',
      )}
    >
      {children}
    </div>
  )
}

/**
 * The camera preview with its state (§10): off with a start button, starting, live (framing
 * marks; "paused" while a result is shown; "Turn camera off" in its corner), or a clear error
 * with "Try again" where that can help. Below it, the camera picker when there is more than
 * one camera. The preview is decorative for assistive technology; the states are text, and
 * camera problems are also announced.
 */
export function CameraView({ camera, phase, setVideo }: CameraViewProps) {
  const { t } = useTranslation(['reception', 'common'])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const attachVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      videoRef.current = video
      setVideo(video)
    },
    [setVideo],
  )

  // "Turn camera off" disappears with the live preview: keep keyboard users on the camera
  // (only when it was turned off, not when the screen opens with the camera off).
  const startRef = useRef<HTMLButtonElement>(null)
  const previousStatus = useRef(camera.status)
  useEffect(() => {
    const turnedOff = camera.status === 'idle' && previousStatus.current !== 'idle'
    previousStatus.current = camera.status
    if (turnedOff && isFocusLost()) startRef.current?.focus()
  }, [camera.status])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== camera.stream) video.srcObject = camera.stream
    if (!camera.stream) return
    // iOS Safari needs an explicit play() for a stream attached after mount; a rejection (e.g.
    // autoplay policy) leaves the last frame, and the next user action plays it.
    const playing = video.play() as Promise<void> | undefined
    playing?.catch(() => {})
  }, [camera.stream])

  const live = camera.status === 'live'
  const paused = live && phase !== 'scanning'
  // While a pass is checked or its result shown, the box shrinks to a strip below lg (stacked
  // layout), whatever the camera does: the result and its action then fit the screen, also
  // when the pass came from the handheld field with the camera off.
  const handlingPass = phase === 'validating' || phase === 'result' || phase === 'acting' || phase === 'success'
  // Spoken: camera problems only. The scanning/paused label changes with every scan and would
  // talk over the result panel's own announcement.
  const announcement = camera.status === 'error' && camera.error ? `${camera.error.title}. ${camera.error.message}` : ''

  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {/*
       * A dark panel showing the live picture: every control in it (Start camera, Try again, Turn
       * camera off) gets a two-tone focus ring, white between dark bands (focus-ring-on-media), that
       * keeps 3:1 on a bright frame and a dark one alike. The app's indigo ring would be 2.8:1 on
       * the panel, and a white ring alone was 1.14:1 on a bright frame (WCAG 1.4.11).
       */}
      <div className="relative grid w-full overflow-hidden rounded-panel border border-border bg-media focus-ring-on-media">
        {/* Sets the box to 4:3 (at least); a strip below lg while a pass is handled (see handlingPass). A longer message still grows it. */}
        <div aria-hidden="true" className={cn('col-start-1 row-start-1 aspect-[4/3] xl:aspect-[16/10]', handlingPass && 'max-lg:aspect-auto max-lg:h-28')} />
        <video
          ref={attachVideo}
          aria-hidden="true"
          muted
          playsInline
          autoPlay
          className={cn('absolute inset-0 size-full object-cover', !live && 'invisible', paused && 'opacity-40')}
        />

        {camera.status === 'idle' && (
          <Overlay compact={handlingPass}>
            <span data-full-only="" className="flex size-16 items-center justify-center rounded-full bg-on-media/10">
              <CameraOff aria-hidden="true" className="size-8 text-on-media-muted" />
            </span>
            <p className="text-base font-semibold">{t('camera.off')}</p>
            <Button ref={startRef} size="lg" icon={<Camera aria-hidden="true" />} onClick={camera.start}>
              {t('camera.start')}
            </Button>
          </Overlay>
        )}

        {camera.status === 'starting' && (
          <Overlay compact={handlingPass}>
            <LoaderCircle aria-hidden="true" className="size-10 animate-spin text-on-media-muted" />
            <p className="font-semibold">{t('camera.starting')}</p>
          </Overlay>
        )}

        {camera.status === 'error' && camera.error && (
          <Overlay>
            <span className="flex size-16 items-center justify-center rounded-full bg-on-media/10">
              <CameraOff aria-hidden="true" className="size-8 text-on-media-muted" />
            </span>
            <p className="text-base font-semibold">{camera.error.title}</p>
            <p className="max-w-md text-sm text-on-media-muted">{camera.error.message}</p>
            {camera.error.retryable && (
              <Button size="lg" icon={<RotateCw aria-hidden="true" />} onClick={camera.start}>
                {t('common:actions.tryAgain')}
              </Button>
            )}
          </Overlay>
        )}

        {live && !paused && <ScanFrame />}
        {live && !paused && (
          // Direction C's chip: the camera is scanning now (the status line below says what to do).
          <p className="absolute start-3 top-3 flex h-9 items-center gap-2 rounded-full border border-on-media/10 bg-media-scrim/70 px-3 text-sm font-medium text-on-media">
            <span aria-hidden="true" className="size-2 shrink-0 animate-live rounded-full bg-highlight text-highlight" />
            {t('camera.live')}
          </p>
        )}
        {(live || camera.status === 'starting') && (
          <button
            type="button"
            onClick={camera.stop}
            title={t('camera.stop')}
            className="absolute end-3 top-3 flex size-11 items-center justify-center rounded-control border border-on-media/15 bg-media-scrim/70 text-on-media transition-colors hover:bg-media-scrim/90"
          >
            <CameraOff aria-hidden="true" className="size-5" />
            <span className="sr-only">{t('camera.stop')}</span>
          </button>
        )}
        {live && (
          <p className="absolute inset-x-3 bottom-4 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-media-scrim/70 px-3.5 py-1.5 text-sm font-medium text-on-media">
            {!paused && <ScanLine aria-hidden="true" className="size-4 shrink-0" />}
            {paused ? t('camera.paused') : t('camera.point')}
          </p>
        )}
      </div>

      {camera.devices.length > 1 && (
        <Field label={t('camera.label')} className="sm:max-w-sm">
          <Select value={camera.deviceId ?? ''} onChange={(event) => camera.selectDevice(event.target.value)}>
            {!camera.devices.some((device) => device.deviceId === camera.deviceId) && <option value="">{t('camera.default')}</option>}
            {camera.devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  )
}
