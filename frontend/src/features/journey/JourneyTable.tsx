import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Avatar } from '../../components/ui/Avatar'
import { Table, type TableColumn } from '../../components/ui/Table'
import { tableRowLinkProps } from '../../components/ui/tableStyles'
import { backLinkState, type BackLink } from '../../hooks/useBackLink'
import { paths } from '../../paths'
import type { JourneyListItem } from '../../types/api'
import { cn } from '../../utils/cn'
import { JourneyStateBadge, SimulatedBadge } from './JourneyBadges'
import { ObservedAt, UnknownLocation } from './JourneyLocation'
import { LocationPath } from './LocationPath'
import { agoSeconds } from './freshness'
import { useLocationName } from './locationNames'
import { secondsBetween } from '../../utils/duration'

const STACK_BELOW = 'lg'
/** A cell's second line (direction C): 12.5 px, muted. */
const SECOND_LINE = 'block text-[0.78125rem] leading-snug text-fg-muted'

interface JourneyColumnContext {
  timeZone: string
  backLink: BackLink
  /** The current time (`useNow`), for "4m ago". */
  now: number
  /** When the server answered these rows: their `freshness_seconds` are counted on from then. */
  answeredAt: number
  /** The page says Simulated already (its line): the rows leave the mark out. */
  simulatedShown: boolean
}

/** The visitor, as the row's link to the visit's journey (the whole card on narrower screens), the company under it. */
function VisitorCell({ item, backLink }: { item: JourneyListItem; backLink: BackLink }) {
  const rowLink = tableRowLinkProps(STACK_BELOW)
  const { visitor } = item.visit
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={visitor.full_name} size="sm" tone={item.visit.status === 'CHECKED_IN' ? 'emphasis' : 'neutral'} />
      <div className="min-w-0">
        <Link
          to={paths.journeyVisit(item.visit.id)}
          state={backLinkState(backLink)}
          {...rowLink}
          className={cn('font-semibold break-words text-accent-text hover:underline lg:text-[0.90625rem] lg:leading-snug', rowLink.className)}
        >
          {visitor.full_name}
        </Link>
        {visitor.company_name && <p className="text-sm font-normal break-words text-fg-muted lg:text-[0.78125rem] lg:leading-snug">{visitor.company_name}</p>}
      </div>
    </div>
  )
}

function LocationCell({ item, timeZone, now, answeredAt }: { item: JourneyListItem } & Pick<JourneyColumnContext, 'timeZone' | 'now' | 'answeredAt'>) {
  const name = useLocationName()
  const location = item.last_location
  if (!location || !item.last_observed_at) return <UnknownLocation />
  return (
    <div className="min-w-0 leading-snug">
      <LocationPath places={[location.floor, location.zone]} className="font-medium text-fg" />
      <span className={SECOND_LINE}>
        <ObservedAt
          at={item.last_observed_at}
          agoSeconds={item.freshness_seconds === null ? secondsBetween(item.last_observed_at, now) : agoSeconds(item.freshness_seconds, answeredAt, now)}
          timeZone={timeZone}
          now={now}
          withDate
          building={name(location.building)}
        />
      </span>
    </div>
  )
}

/*
 * From lg: a table with fixed widths (the visitor and the host share what the state and the location
 * leave). Below lg: a card per visit, its title the link to the journey, the state chips on one line, the
 * host and the location as labelled lines.
 */
function journeyColumns({ t, ...context }: JourneyColumnContext & { t: TFunction<'journey'> }): TableColumn<JourneyListItem>[] {
  return [
    {
      id: 'visitor',
      header: t('list.columns.visitor'),
      primary: true,
      headerClassName: 'lg:w-[30%]',
      cell: (item) => <VisitorCell item={item} backLink={context.backLink} />,
    },
    {
      id: 'state',
      header: t('list.columns.state'),
      stacked: 'inline',
      headerClassName: 'lg:w-[11rem]',
      cell: (item) => (
        <div className="flex flex-wrap gap-1 lg:flex-col lg:items-start">
          <JourneyStateBadge state={item.state} />
          {item.simulated && !context.simulatedShown && <SimulatedBadge />}
        </div>
      ),
    },
    {
      id: 'host',
      header: t('list.columns.host'),
      headerClassName: 'lg:w-[22%]',
      cell: (item) => <span className="break-words text-fg">{item.visit.host.full_name}</span>,
    },
    {
      id: 'location',
      header: t('list.columns.location'),
      cell: (item) => <LocationCell item={item} timeZone={context.timeZone} now={context.now} answeredAt={context.answeredAt} />,
    },
  ]
}

export interface JourneyTableProps extends JourneyColumnContext {
  items: JourneyListItem[]
  loading?: boolean
  empty?: ReactNode
}

/** The day's visits and their journeys: read-only; every row leads to the visit's journey. */
export function JourneyTable({ items, loading, empty, ...context }: JourneyTableProps) {
  const { t } = useTranslation('journey')
  return (
    <Table
      columns={journeyColumns({ ...context, t })}
      rows={items}
      getRowKey={(item) => item.visit.id}
      caption={t('title')}
      loading={loading}
      empty={empty}
      stackBelow={STACK_BELOW}
      layout="fixed"
      isRowHighlighted={(item) => item.state === 'ACTIVE'}
    />
  )
}
