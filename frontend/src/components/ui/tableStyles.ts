/** Below this breakpoint every row of a Table is a stacked card. */
export type TableStackBreakpoint = 'md' | 'lg' | 'xl'

/*
 * Tailwind only generates classes it finds spelled out in the source, so each breakpoint's
 * classes are written in full.
 *
 * In a card, each labelled value is a two-column line: the label in a narrow column and the
 * value aligned to the start beside it, so they stay together however wide the card is. Cards of an
 * `lg` or `xl` table sit in two columns from md, where one card per row would leave most of
 * its width empty. The media ranges never overlap, so no two display utilities compete.
 * `xl` is for a table whose columns need more than the 702 px a 1024 px screen leaves beside
 * the sidebar (the visit history). Below 360 px (a small phone, a desktop zoomed to 400 %) the label
 * column is 6 rem: at 8 rem a phone number (one unbreakable line) stuck out of a 320 px card by 8 px
 * (phase 10 review's reflow check).
 */
export const TABLE_STACK_CLASSES = {
  md: {
    frame: 'md:rounded-card md:border md:border-border md:bg-surface',
    wrapper: 'md:overflow-x-auto',
    table: 'max-md:block',
    fixed: 'md:table-fixed',
    fixedXl: 'xl:table-fixed',
    thead: 'max-md:sr-only',
    tbody: 'max-md:flex max-md:flex-col max-md:gap-3 md:divide-y md:divide-border-subtle',
    row: 'max-md:relative max-md:block max-md:rounded-card max-md:border max-md:border-border max-md:p-4 max-md:has-[a[data-row-link]:hover]:border-border-strong',
    rowSurface: 'max-md:bg-surface',
    headerCell: 'px-4 py-3',
    cell: 'md:px-4 md:py-3',
    rowCell:
      'max-md:grid max-md:grid-cols-[minmax(6rem,8rem)_minmax(0,1fr)] max-[22.5rem]:grid-cols-[6rem_minmax(0,1fr)] max-md:items-start max-md:gap-x-3 max-md:py-1',
    primaryCell: 'max-md:block max-md:pb-1 max-md:text-base max-md:font-semibold md:pointer-coarse:relative',
    actionsCell: 'max-md:flex max-md:justify-end max-md:py-1',
    inlineCell: 'max-md:me-2 max-md:inline-flex max-md:items-center max-md:py-1 max-md:align-middle',
    hiddenCell: 'max-md:hidden',
    alignEnd: 'md:text-end',
    label: 'md:hidden',
    rowLink: 'max-md:after:absolute max-md:after:inset-0 max-md:after:rounded-card md:pointer-coarse:after:absolute md:pointer-coarse:after:inset-0',
  },
  lg: {
    frame: 'lg:rounded-card lg:border lg:border-border lg:bg-surface',
    wrapper: 'lg:overflow-x-auto',
    table: 'max-lg:block',
    fixed: 'lg:table-fixed',
    fixedXl: 'xl:table-fixed',
    thead: 'max-lg:sr-only',
    tbody: 'max-md:flex max-md:flex-col max-md:gap-3 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:gap-3 lg:divide-y lg:divide-border-subtle',
    row: 'max-lg:relative max-lg:block max-lg:rounded-card max-lg:border max-lg:border-border max-lg:p-4 max-lg:has-[a[data-row-link]:hover]:border-border-strong',
    rowSurface: 'max-lg:bg-surface',
    headerCell: 'px-4 py-3',
    cell: 'lg:px-4 lg:py-3',
    rowCell:
      'max-lg:grid max-lg:grid-cols-[minmax(6rem,8rem)_minmax(0,1fr)] max-[22.5rem]:grid-cols-[6rem_minmax(0,1fr)] max-lg:items-start max-lg:gap-x-3 max-lg:py-1',
    primaryCell: 'max-lg:block max-lg:pb-1 max-lg:text-base max-lg:font-semibold lg:pointer-coarse:relative',
    actionsCell: 'max-lg:flex max-lg:justify-end max-lg:py-1',
    inlineCell: 'max-lg:me-2 max-lg:inline-flex max-lg:items-center max-lg:py-1 max-lg:align-middle',
    hiddenCell: 'max-lg:hidden',
    alignEnd: 'lg:text-end',
    label: 'lg:hidden',
    rowLink: 'max-lg:after:absolute max-lg:after:inset-0 max-lg:after:rounded-card lg:pointer-coarse:after:absolute lg:pointer-coarse:after:inset-0',
  },
  xl: {
    frame: 'xl:rounded-card xl:border xl:border-border xl:bg-surface',
    wrapper: 'xl:overflow-x-auto',
    table: 'max-xl:block',
    fixed: 'xl:table-fixed',
    fixedXl: 'xl:table-fixed',
    thead: 'max-xl:sr-only',
    tbody: 'max-md:flex max-md:flex-col max-md:gap-3 md:max-xl:grid md:max-xl:grid-cols-2 md:max-xl:gap-3 xl:divide-y xl:divide-border-subtle',
    row: 'max-xl:relative max-xl:block max-xl:rounded-card max-xl:border max-xl:border-border max-xl:p-4 max-xl:has-[a[data-row-link]:hover]:border-border-strong',
    rowSurface: 'max-xl:bg-surface',
    // Tighter until 2xl, where the widest table is the 958 px of a 1280 px screen.
    headerCell: 'px-3 py-3 2xl:px-4',
    cell: 'xl:px-3 xl:py-3 2xl:px-4',
    rowCell:
      'max-xl:grid max-xl:grid-cols-[minmax(6rem,8rem)_minmax(0,1fr)] max-[22.5rem]:grid-cols-[6rem_minmax(0,1fr)] max-xl:items-start max-xl:gap-x-3 max-xl:py-1',
    primaryCell: 'max-xl:block max-xl:pb-1 max-xl:text-base max-xl:font-semibold xl:pointer-coarse:relative',
    actionsCell: 'max-xl:flex max-xl:justify-end max-xl:py-1',
    inlineCell: 'max-xl:me-2 max-xl:inline-flex max-xl:items-center max-xl:py-1 max-xl:align-middle',
    hiddenCell: 'max-xl:hidden',
    alignEnd: 'xl:text-end',
    label: 'xl:hidden',
    rowLink: 'max-xl:after:absolute max-xl:after:inset-0 max-xl:after:rounded-card xl:pointer-coarse:after:absolute xl:pointer-coarse:after:inset-0',
  },
} as const

/**
 * Props for a row's main link (in the primary column): in the stacked layout the link's hit
 * area covers the whole card, so the card is one large touch target that shows hover. In the
 * table layout on a touch screen it covers its cell (the row's height, at least 44 px), not
 * just the line of text. Other interactive elements in the card or that cell must sit above it
 * (`relative z-10`). Pass the table's `stackBelow`.
 *
 * A touch target under the link in the same cell (the evacuation list's phone link) takes that
 * part of the card or cell from the link: wrap the link's own lines in `ROW_LINK_LINES_ABOVE_TARGET`.
 */
export function tableRowLinkProps(stackBelow: TableStackBreakpoint = 'md'): { className: string; 'data-row-link': '' } {
  return { className: TABLE_STACK_CLASSES[stackBelow].rowLink, 'data-row-link': '' }
}

/**
 * The row link's own lines (name, company) when a touch target sits under them in the same cell:
 * the evacuation list's visitor phone, whose touch area reaches 12 px up (`PhoneLink`). On a touch
 * screen, in the cards and in the table alike, the lines are at least 44 px tall and keep those
 * 12 px clear under them. That touch area then starts under their last line however many lines the
 * name wraps to, with or without a company line, and the link keeps a band at least 44 px tall
 * above it: from the card's top edge (16 px padding + 44 px), or the cell's (12 px + 44 px). Before,
 * only the table had the 44 px, and in a card without a company line the phone took the lower 8 px
 * of the name (a tap there dialled instead of opening the visit). Nothing changes with a mouse.
 */
export const ROW_LINK_LINES_ABOVE_TARGET = 'pointer-coarse:mb-3 pointer-coarse:min-h-11'
