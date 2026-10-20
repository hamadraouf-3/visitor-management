import { useState, type ReactNode } from 'react'
import { useColorScheme } from '../../appearance/useAppearance'
import type { CompanyBrand } from '../../types/api'
import { cn } from '../../utils/cn'

export interface CompanyLogoProps {
  /** The company's identity: its logo for light surfaces, the optional one for dark surfaces. */
  brand: CompanyBrand
  /** The company's name in the UI language: the logo's text alternative, and the wordmark when it has no logo. */
  name: string
  /**
   * Where it stands. `shell`: the coloured shell: the dark-surface logo where the shell is dark, else
   * the logo on a white plate. `page`: a light page (sign-in, errors, the visitor pass), dark in the
   * dark colour scheme: the logo on the page itself, and in the dark scheme the dark-surface logo, or
   * the logo on a white plate for a company without one. `paper`: print, always the logo for light
   * surfaces, on the paper itself.
   */
  surface: 'shell' | 'page' | 'paper'
  /** `sm` the phone and tablet top bar, `md` the sidebar and the drawer, `lg` the public pages. */
  size?: 'sm' | 'md' | 'lg'
  /**
   * The shell as a surface. `dark` (the default): white reads on it, so the logo for dark surfaces
   * does too. `light`: the company's colour is a light one (a yellow, a pastel, white) under dark
   * ink, where a logo for dark surfaces would not show: the logo stands on its white plate, and the
   * dark-surface logo is used only in the dark colour scheme, where the shell is the deep one.
   */
  shellTone?: 'dark' | 'light'
  /** The name is said next to it anyway: the image has no text alternative. */
  decorative?: boolean
  /**
   * An emblem (a logo about as wide as it is tall, or taller) does not say whose it is: the company's
   * name is written beside it. Off where the name already stands next to the logo (a printed sheet's
   * header).
   */
  nameBeside?: boolean
  className?: string
}

/* The logo's box per place: it keeps its own proportions inside (a wide wordmark, a square emblem). */
const IMAGE = {
  shell: { sm: 'max-h-8 max-w-[7rem]', md: 'max-h-10 max-w-[9.5rem]', lg: 'max-h-12 max-w-[12rem]' },
  plate: { sm: 'max-h-7 max-w-[6.25rem]', md: 'max-h-8 max-w-[8.5rem]', lg: 'max-h-10 max-w-[11rem]' },
  page: { sm: 'max-h-9 max-w-[9rem]', md: 'max-h-12 max-w-[12rem]', lg: 'max-h-14 max-w-[14rem]' },
  paper: { sm: 'max-h-[0.36in] max-w-[1.6in]', md: 'max-h-[0.42in] max-w-[1.9in]', lg: 'max-h-[0.5in] max-w-[2.4in]' },
} as const

/** The white plate under a logo for light surfaces, where the surface is not one: its shape per size. */
const PLATE = { sm: 'rounded-[0.5rem] px-1.5 py-1', md: 'rounded-item px-2 py-1.5', lg: 'rounded-control px-3 py-2' } as const
/** In the dark colour scheme (on screen) a company's own logo for dark surfaces needs no plate: the plate lets go of its fill there. */
const PLATE_GONE_IN_DARK = 'scheme-dark:border-transparent scheme-dark:bg-transparent'
/**
 * The logo's room on a light page (sign-in, the visitor's pass, an error page). In the light scheme
 * the logo stands on the page itself, as the company drew it: no fill, no edge (Phase 13, F13-26).
 * Only a logo for light surfaces drawn on the dark page (the dark scheme, a company without a logo for
 * dark surfaces) gets a plate there: white, with the cards' edge. The room is the same in both schemes,
 * so nothing moves when the scheme changes but the logo itself.
 */
const PAGE_ROOM = { sm: 'rounded-[0.5rem] px-2 py-1.5', md: 'rounded-item px-3 py-2', lg: 'rounded-[0.875rem] px-4 py-3' } as const
/** The page's plate, in the dark colour scheme only (on screen: paper is light). */
const PAGE_PLATE_IN_DARK = 'scheme-dark:border-border scheme-dark:bg-white'

const WORDMARK = {
  shell: {
    sm: 'max-w-[9rem] truncate text-[0.9375rem] leading-tight sm:max-w-[16rem]',
    md: 'line-clamp-2 max-w-[9.75rem] text-[1.125rem] leading-snug',
    lg: 'line-clamp-2 text-xl leading-snug',
  },
  page: { sm: 'text-base leading-tight', md: 'text-xl leading-tight', lg: 'text-[1.75rem] leading-tight' },
  paper: { sm: 'text-[11pt] leading-tight', md: 'text-[12pt] leading-tight', lg: 'text-[15pt] leading-tight' },
} as const

/** The company's name beside an emblem: smaller than the wordmark of a company without a logo, since the emblem leads. */
const NAME_BESIDE = {
  shell: {
    sm: 'max-w-[7rem] truncate text-[0.9375rem] leading-tight sm:max-w-[14rem]',
    md: 'line-clamp-2 max-w-[6.25rem] text-[0.9375rem] leading-snug',
    lg: 'line-clamp-2 text-lg leading-snug',
  },
  page: { sm: 'text-base leading-tight', md: 'text-lg leading-tight', lg: 'max-w-[13rem] text-[1.375rem] leading-tight' },
  paper: { sm: 'text-[10pt] leading-tight', md: 'text-[11pt] leading-tight', lg: 'text-[13pt] leading-tight' },
} as const

const GAP = { sm: 'gap-2', md: 'gap-2.5', lg: 'gap-3' } as const

/** A logo at most this much wider than tall is an emblem: a mark, not a name. */
export const EMBLEM_MAX_RATIO = 1.4

/**
 * A company's logo (Phase 12), or its name as a wordmark when it has none (or its file does not
 * load). Phrasing content only, so it can be a heading's text (the navigation drawer's title). It
 * never shows the product's logo: a company without a logo is its own name.
 */
export function CompanyLogo({ brand, name, surface, size = 'md', shellTone = 'dark', decorative = false, nameBeside = true, className }: CompanyLogoProps) {
  // A file that does not load (removed a moment ago, a stale address) is given up, per address: the
  // other logo stands in for it, or the name for both.
  const [failed, setFailed] = useState<readonly string[]>([])
  // The proportions of the logo on screen, known once its file is: an emblem gets the name beside it.
  const [shape, setShape] = useState<{ source: string; ratio: number } | null>(null)
  // The scheme of the device's appearance (Phase 13), not the device's own: a device that chose Dark gets the dark logo.
  const scheme = useColorScheme()

  const light = brand.logo_url !== null && !failed.includes(brand.logo_url) ? brand.logo_url : null
  const dark = brand.logo_dark_url !== null && !failed.includes(brand.logo_dark_url) ? brand.logo_dark_url : null
  const source = `${light ?? ''}|${dark ?? ''}`
  const emblem = nameBeside && shape !== null && shape.source === source && shape.ratio <= EMBLEM_MAX_RATIO
  // Beside the written name the picture says nothing more.
  const alt = decorative || emblem ? '' : name

  const measure = (element: HTMLImageElement | null) => {
    if (!element || !element.complete || !(element.naturalWidth > 0 && element.naturalHeight > 0)) return
    const ratio = element.naturalWidth / element.naturalHeight
    setShape((current) => (current && current.source === source && current.ratio === ratio ? current : { source, ratio }))
  }
  // On the shell a wide logo gives way to the controls beside it (a phone's top bar): it shrinks, in its proportions. An emblem keeps its size; its name gives way.
  const fit = surface === 'shell' && !emblem ? 'min-w-0' : 'shrink-0'
  const image = (src: string, variant: 'light' | 'dark', sizes: string) => (
    <img
      // A file the browser already holds is measured as it is placed; any other when it has loaded.
      ref={measure}
      src={src}
      alt={alt}
      // On paper the logo must be in the very first frame the print layout draws: decoded with it, not after.
      decoding={surface === 'paper' ? 'sync' : 'async'}
      draggable={false}
      data-company-logo={variant}
      onLoad={(event) => measure(event.currentTarget)}
      onError={(event) => {
        // In a picture the file shown may be its source's, the logo for dark surfaces: only the one that failed is given up.
        const shown = event.currentTarget.currentSrc
        const address = shown && dark !== null && shown === new URL(dark, event.currentTarget.baseURI).href ? dark : src
        setFailed((current) => (current.includes(address) ? current : [...current, address]))
      }}
      className={cn('block h-auto w-auto object-contain select-none', fit, sizes)}
    />
  )
  /**
   * The logo for light surfaces, and in the dark colour scheme the one for dark surfaces: on screen only,
   * so a page printed in the dark scheme still puts the logo for light surfaces on paper.
   */
  const eitherScheme = (lightSource: string, darkSource: string, sizes: string) => (
    <picture className="contents">
      {scheme === 'dark' && <source media="screen" srcSet={darkSource} />}
      {image(lightSource, 'light', sizes)}
    </picture>
  )

  let mark: ReactNode = null
  if (surface === 'shell' && shellTone === 'dark' && dark) {
    mark = <span className={cn('inline-flex', fit)}>{image(dark, 'dark', IMAGE.shell[size])}</span>
  } else if (surface === 'shell' && light) {
    // On a colour that is not white the logo for light surfaces stands on its plate, whether that colour
    // is dark or light: a company's colour is its logo's, and a logo drawn on its own colour disappears.
    const swaps = shellTone === 'light' && dark !== null
    mark = (
      <span data-logo-plate={swaps ? 'light-scheme' : ''} className={cn('inline-flex bg-white', fit, PLATE[size], swaps && PLATE_GONE_IN_DARK)}>
        {swaps ? eitherScheme(light, dark, IMAGE.plate[size]) : image(light, 'light', IMAGE.plate[size])}
      </span>
    )
  } else if (surface === 'page' && light) {
    // `data-logo-plate="dark-scheme"`: the plate is drawn in the dark scheme only; a company with a logo for dark surfaces never has one here.
    mark = (
      <span
        data-logo-plate={dark ? undefined : 'dark-scheme'}
        data-logo-room=""
        className={cn('inline-flex shrink-0 border border-transparent', PAGE_ROOM[size], !dark && PAGE_PLATE_IN_DARK)}
      >
        {dark ? eitherScheme(light, dark, IMAGE.page[size]) : image(light, 'light', IMAGE.page[size])}
      </span>
    )
  } else if (surface === 'paper' && light) {
    mark = <span className="inline-flex shrink-0">{image(light, 'light', IMAGE.paper[size])}</span>
  }

  const ink = surface === 'paper' ? 'text-black' : 'text-fg'
  if (mark === null) {
    return (
      <span
        data-company-wordmark=""
        dir="auto"
        className={cn('font-display font-bold tracking-[-0.01em] break-words', WORDMARK[surface][size], ink, surface === 'page' && 'text-center', className)}
      >
        {name}
      </span>
    )
  }
  if (!emblem) return <span className={cn('inline-flex min-w-0', className)}>{mark}</span>
  return (
    <span data-logo-with-name="" className={cn('inline-flex min-w-0 items-center', GAP[size], className)}>
      {mark}
      <span data-company-name="" dir="auto" className={cn('min-w-0 font-display font-bold tracking-[-0.01em] break-words', NAME_BESIDE[surface][size], ink)}>
        {name}
      </span>
    </span>
  )
}
