import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { InvitationStatus, PassStatus, VisitStatus } from '../../types/api'
import { StatusBadge } from './StatusBadge'

/** The chip around a status label. */
const chip = (label: string) => screen.getByText(label).closest('span.rounded-full')

describe('StatusBadge', () => {
  it.each([
    ['SCHEDULED', 'Scheduled', 'bg-status-scheduled-bg'],
    ['CHECKED_IN', 'Checked in', 'bg-status-in-bg'],
    ['CHECKED_OUT', 'Checked out', 'bg-status-out-bg'],
    ['CANCELLED', 'Cancelled', 'bg-status-cancelled-bg'],
    ['NO_SHOW', 'No-show', 'bg-status-noshow-bg'],
  ] as [VisitStatus, string, string][])('shows visit status %s as text and icon in its own chip colours', (status, label, chipClass) => {
    const { container } = render(<StatusBadge type="visit" status={status} />)

    const badge = screen.getByText(label).closest('span.rounded-full')
    expect(badge).toHaveClass(chipClass)
    // Never color alone: a decorative icon accompanies the text.
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it.each([
    ['NOT_SENT', 'Not sent'],
    ['PENDING', 'Sending'],
    ['SENT', 'Sent'],
    ['FAILED', 'Failed'],
  ] as [InvitationStatus, string][])('labels invitation status %s', (status, label) => {
    render(<StatusBadge type="invitation" status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it.each([
    ['NOT_SENT', 'Invitation not sent'],
    ['PENDING', 'Sending invitation'],
    ['SENT', 'Invitation sent'],
    ['FAILED', 'Invitation failed'],
  ] as [InvitationStatus, string][])('names the subject of invitation status %s where no "Invitation" heading does', (status, label) => {
    render(<StatusBadge type="invitation" status={status} standalone />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('words a FAILED that is only the calendar invitation’s as such, short under a heading and long on its own', () => {
    const { container, rerender } = render(<StatusBadge type="invitation" status="FAILED" calendarFailed />)
    expect(chip('Calendar failed')).toHaveClass('bg-danger-surface')
    expect(container.querySelector('svg.lucide-calendar-x2, svg.lucide-calendar-x-2')).not.toBeNull()
    rerender(<StatusBadge type="invitation" status="FAILED" calendarFailed standalone />)
    expect(chip('Calendar invitation not delivered')).toHaveClass('bg-danger-surface')
    // Only a FAILED invitation: any other state keeps its words.
    rerender(<StatusBadge type="invitation" status="SENT" calendarFailed standalone />)
    expect(screen.getByText('Invitation sent')).toBeInTheDocument()
    rerender(<StatusBadge type="invitation" status="FAILED" calendarFailed={false} standalone />)
    expect(screen.getByText('Invitation failed')).toBeInTheDocument()
  })

  it('can show a status as history in a neutral tone, still with its icon and words', () => {
    const { container } = render(<StatusBadge type="invitation" status="SENT" tone="neutral" />)
    const badge = screen.getByText('Sent').closest('span.rounded-full')
    expect(badge).toHaveClass('bg-neutral-surface')
    expect(badge).not.toHaveClass('bg-success-surface')
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it.each([
    ['ACTIVE', 'Active'],
    ['REVOKED', 'Revoked'],
    ['EXPIRED', 'Expired'],
    ['NONE', 'No pass'],
  ] as [PassStatus, string][])('labels pass status %s', (status, label) => {
    render(<StatusBadge type="pass" status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it("draws a visit status as direction C's 28 px chip (13 px text) and secondary states as compact chips", () => {
    render(
      <>
        <StatusBadge type="visit" status="CHECKED_IN" />
        <StatusBadge type="invitation" status="SENT" />
        <StatusBadge type="pass" status="ACTIVE" />
        <StatusBadge type="visit" status="SCHEDULED" size="sm" />
      </>,
    )

    expect(chip('Checked in')).toHaveAttribute('data-size', 'md')
    expect(chip('Checked in')).toHaveClass('min-h-7', 'px-3', 'text-[0.8125rem]')
    expect(chip('Sent')).toHaveAttribute('data-size', 'sm')
    expect(chip('Sent')).toHaveClass('min-h-6', 'text-xs')
    expect(chip('Active')).toHaveAttribute('data-size', 'sm')
    // A screen short of room can still ask for the compact chip.
    expect(chip('Scheduled')).toHaveAttribute('data-size', 'sm')
  })
})
