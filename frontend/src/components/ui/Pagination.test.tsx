import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from './Pagination'

function PagedList({ initialPage, onPageChange }: { initialPage: number; onPageChange: (page: number) => void }) {
  const [page, setPage] = useState(initialPage)
  return (
    <Pagination
      page={page}
      pageSize={25}
      total={60}
      onPageChange={(next) => {
        onPageChange(next)
        setPage(next)
      }}
    />
  )
}

describe('Pagination', () => {
  it('summarises the range in a named landmark and moves to the next page', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn<(page: number) => void>()
    render(<Pagination page={1} pageSize={25} total={60} onPageChange={onPageChange} />)

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Showing 1–25 of 60')
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute('aria-disabled', 'true')

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('keeps focus on Next when it reaches the last page, and Next then does nothing', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn<(page: number) => void>()
    render(<PagedList initialPage={2} onPageChange={onPageChange} />)
    const next = screen.getByRole('button', { name: 'Next' })

    next.focus()
    await user.keyboard('{Enter}')

    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    expect(screen.getByText('Showing 51–60 of 60')).toBeInTheDocument()
    expect(next).toHaveFocus()
    expect(next).toBeEnabled()
    expect(next).toHaveAttribute('aria-disabled', 'true')

    await user.keyboard('{Enter}')
    expect(onPageChange).toHaveBeenCalledTimes(1)
    expect(onPageChange).toHaveBeenCalledWith(3)
  })

  it('keeps focus on Previous when it reaches the first page', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn<(page: number) => void>()
    render(<PagedList initialPage={2} onPageChange={onPageChange} />)
    const previous = screen.getByRole('button', { name: 'Previous' })

    await user.click(previous)

    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(previous).toHaveFocus()
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Next' })).not.toHaveAttribute('aria-disabled')

    await user.click(previous)
    expect(onPageChange).toHaveBeenCalledTimes(1)
  })

  it('shows only the range when everything fits on one page', () => {
    const { rerender } = render(<Pagination page={1} pageSize={25} total={5} onPageChange={() => {}} />)

    expect(screen.getByText('Showing 1–5 of 5')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(<Pagination page={1} pageSize={25} total={0} onPageChange={() => {}} />)
    expect(screen.getByText('No results')).toBeInTheDocument()
  })
})
