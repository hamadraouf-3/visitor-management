import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DateTimeField } from './DateTimeField'

function Harness({
  initial,
  timeZone,
  onChange,
  error,
}: {
  initial: string | null
  timeZone: string
  onChange?: (value: string | null) => void
  error?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <DateTimeField
      label="Starts"
      timeZone={timeZone}
      value={value}
      error={error}
      required
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

const date = () => screen.getByLabelText('Starts date')
const time = () => screen.getByRole('combobox', { name: 'Starts time' })
const times = () => within(time()).getAllByRole('option').map((option) => option.textContent)

describe('DateTimeField', () => {
  it('is one named group of a date and a 24-hour time in company wall time, whatever the browser timezone', () => {
    render(<Harness initial="2026-10-05T18:00:00.000Z" timeZone="Asia/Amman" />)

    expect(screen.getByRole('group', { name: 'Starts' })).toBeInTheDocument()
    expect(date()).toHaveValue('2026-10-05')
    // 18:00 UTC is 21:00 in Amman: 24-hour, never "09:00 PM".
    expect(time()).toHaveValue('21:00')
    // No time-zone note by default (brand pass, decision 3).
    expect(date()).not.toHaveAttribute('aria-describedby')
    expect(time()).not.toHaveAttribute('aria-describedby')
    expect(date()).toHaveAttribute('aria-required', 'true')
    expect(time()).toHaveAttribute('aria-required', 'true')
  })

  it('offers every quarter hour of the day as HH:mm', () => {
    render(<Harness initial="2026-10-05T06:00:00.000Z" timeZone="Asia/Amman" />)

    expect(times()).toHaveLength(96)
    expect(times().slice(0, 5)).toEqual(['00:00', '00:15', '00:30', '00:45', '01:00'])
    expect(times().at(-1)).toBe('23:45')
  })

  it('also offers a current time that is off the grid', () => {
    render(<Harness initial="2026-10-05T06:07:00.000Z" timeZone="Asia/Amman" />)

    expect(time()).toHaveValue('09:07')
    expect(times()).toHaveLength(97)
    expect(times().slice(36, 39)).toEqual(['09:00', '09:07', '09:15'])
  })

  it('names the time zone when asked to', () => {
    render(<DateTimeField label="Starts" timeZone="Asia/Amman" value={null} onChange={() => {}} showTimeZone />)

    expect(date()).toHaveAccessibleDescription('Amman time (UTC+3)')
    expect(time()).toHaveAccessibleDescription('Amman time (UTC+3)')
  })

  it('can leave the time zone to a hint shared by a group of fields', () => {
    render(
      <>
        <p id="schedule-hint">Times in Amman time (UTC+3).</p>
        <DateTimeField label="Starts" timeZone="Asia/Amman" value={null} onChange={() => {}} showTimeZone={false} describedBy="schedule-hint" />
      </>,
    )

    expect(date()).toHaveAccessibleDescription('Times in Amman time (UTC+3).')
    expect(time()).toHaveAccessibleDescription('Times in Amman time (UTC+3).')
  })

  it('links an error to both controls and marks them invalid', () => {
    render(<Harness initial="2026-10-05T06:00:00.000Z" timeZone="Asia/Amman" error="The start cannot be in the past." />)

    expect(date()).toHaveAttribute('aria-invalid', 'true')
    expect(time()).toHaveAttribute('aria-invalid', 'true')
    expect(date()).toHaveAccessibleDescription(/The start cannot be in the past\./)
    expect(time()).toHaveAccessibleDescription(/The start cannot be in the past\./)
  })

  it('emits a UTC instant for the chosen company date and time', () => {
    const onChange = vi.fn<(value: string | null) => void>()
    render(<Harness initial="2026-10-05T06:00:00.000Z" timeZone="Asia/Amman" onChange={onChange} />)

    fireEvent.change(date(), { target: { value: '2026-10-06' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-10-06T06:00:00.000Z')

    fireEvent.change(time(), { target: { value: '00:30' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-10-05T21:30:00.000Z')
  })

  it('emits null while the date is cleared and keeps the chosen time for when it is complete again', () => {
    const onChange = vi.fn<(value: string | null) => void>()
    render(<Harness initial="2026-10-05T06:00:00.000Z" timeZone="Asia/Amman" onChange={onChange} />)

    fireEvent.change(date(), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(time()).toHaveValue('09:00')

    fireEvent.change(time(), { target: { value: '10:15' } })
    expect(onChange).toHaveBeenLastCalledWith(null)

    fireEvent.change(date(), { target: { value: '2026-10-07' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-10-07T07:15:00.000Z')
  })

  it('asks for a time when there is none yet', () => {
    const onChange = vi.fn<(value: string | null) => void>()
    render(<Harness initial={null} timeZone="Asia/Amman" onChange={onChange} />)

    expect(time()).toHaveValue('')
    expect(within(time()).getByRole('option', { name: '--:--' })).toBeDisabled()
    fireEvent.change(date(), { target: { value: '2026-10-06' } })
    expect(onChange).toHaveBeenLastCalledWith(null)

    fireEvent.change(time(), { target: { value: '14:00' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-10-06T11:00:00.000Z')
    expect(within(time()).queryByRole('option', { name: '--:--' })).toBeNull()
  })

  it('does not offer times a daylight-saving gap removes, and explains when a date change lands in one', () => {
    const onChange = vi.fn<(value: string | null) => void>()
    // 02:30 on Sat 7 Mar 2026 in New York (EST, UTC−5).
    render(<Harness initial="2026-03-07T07:30:00.000Z" timeZone="America/New_York" onChange={onChange} />)
    expect(times()).toContain('02:30')

    // On Sun 8 Mar the clocks jump from 02:00 to 03:00: 02:30 does not exist that day.
    fireEvent.change(date(), { target: { value: '2026-03-08' } })

    expect(onChange).toHaveBeenLastCalledWith('2026-03-08T07:30:00.000Z')
    expect(time()).toHaveValue('03:30')
    expect(times()).not.toContain('02:30')
    expect(times()).toHaveLength(92)
    expect(screen.getByText(/does not exist in New York time/)).toHaveTextContent('it will be saved as 03:30')
  })
})
