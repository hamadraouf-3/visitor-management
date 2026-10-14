/** Semantic tones shared by badges, alerts, stat tiles and toasts (see index.css tokens). */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export const toneSurfaceClasses: Record<Tone, string> = {
  neutral: 'border-neutral-border bg-neutral-surface text-neutral-text',
  info: 'border-info-border bg-info-surface text-info-text',
  success: 'border-success-border bg-success-surface text-success-text',
  warning: 'border-warning-border bg-warning-surface text-warning-text',
  danger: 'border-danger-border bg-danger-surface text-danger-text',
  accent: 'border-accent-border bg-accent-surface text-accent-text',
}

export const toneIconClasses: Record<Tone, string> = {
  neutral: 'text-neutral-solid',
  info: 'text-info-solid',
  success: 'text-success-solid',
  warning: 'text-warning-solid',
  danger: 'text-danger-solid',
  accent: 'text-accent-text',
}

/** A tinted square behind an icon (stat tiles, list markers), as in direction C. */
export const toneTileClasses: Record<Tone, string> = {
  neutral: 'bg-neutral-surface text-neutral-solid',
  info: 'bg-info-surface text-info-solid',
  success: 'bg-success-surface text-success-solid',
  warning: 'bg-warning-surface text-warning-solid',
  danger: 'bg-danger-surface text-danger-solid',
  accent: 'bg-accent-surface text-accent-text',
}
