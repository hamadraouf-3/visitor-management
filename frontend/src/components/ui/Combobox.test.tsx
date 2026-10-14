import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type FormEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/api'
import { createTestQueryClient } from '../../test/render'
import type { Host } from '../../types/api'
import { AsyncCombobox } from './AsyncCombobox'
import { Combobox } from './Combobox'
import { Dialog } from './Dialog'
import { Field } from './Field'

const HOSTS: Host[] = [
  { id: 'h1', full_name: 'Lina Haddad', phone: '+962 79 000 0001', department: { id: 'd1', name: 'Finance', name_ar: null } },
  { id: 'h2', full_name: 'Omar Khalil', phone: null, department: null },
  { id: 'h3', full_name: 'Élodie Martin', phone: null, department: { id: 'd2', name: 'Legal', name_ar: null } },
]

function HostPicker({ onChange = () => {} }: { onChange?: (host: Host | null) => void }) {
  const [value, setValue] = useState<Host | null>(null)
  const [query, setQuery] = useState('')
  const options = HOSTS.filter((host) => host.full_name.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <Field label="Host">
      <Combobox
        value={value}
        onChange={(host) => {
          setValue(host)
          onChange(host)
        }}
        options={options}
        onQueryChange={setQuery}
        getOptionKey={(host) => host.id}
        getOptionLabel={(host) => host.full_name}
      />
    </Field>
  )
}

describe('Combobox', () => {
  it('filters as you type and selects with the keyboard', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn<(host: Host | null) => void>()
    render(<HostPicker onChange={onChange} />)
    const input = screen.getByRole('combobox', { name: 'Host' })

    await user.type(input, 'kha')

    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Omar Khalil'])
    expect(screen.getByRole('status')).toHaveTextContent('1 result available.')

    await user.keyboard('{ArrowDown}')
    const option = screen.getByRole('option', { name: 'Omar Khalil' })
    expect(input).toHaveAttribute('aria-activedescendant', option.id)

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(HOSTS[1])
    expect(input).toHaveValue('Omar Khalil')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('selects with the pointer and restores the selected label on blur', async () => {
    const user = userEvent.setup({ delay: null })
    render(<HostPicker />)
    const input = screen.getByRole('combobox', { name: 'Host' })

    await user.type(input, 'lin')
    await user.click(screen.getByRole('option', { name: 'Lina Haddad' }))
    expect(input).toHaveValue('Lina Haddad')

    await user.clear(input)
    await user.type(input, 'xyz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('No matches found.')
    await user.tab()
    expect(input).toHaveValue('Lina Haddad')
  })

  it('clears the selection when the text is emptied', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn<(host: Host | null) => void>()
    render(<HostPicker onChange={onChange} />)
    const input = screen.getByRole('combobox', { name: 'Host' })
    await user.type(input, 'lin')
    await user.keyboard('{ArrowDown}{Enter}')

    await user.clear(input)
    await user.tab()

    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it.each([
    ['loading', { loading: true }, 'Loading…'],
    ['error', { errorMessage: 'Could not load hosts.' }, 'Could not load hosts.'],
    ['idle', { idleMessage: 'Type at least 2 characters to search.' }, 'Type at least 2 characters to search.'],
  ])(
    'ignores arrows and Enter in the %s state, so options the user cannot see are never picked',
    async (_state, statusProps, statusText) => {
      const user = userEvent.setup({ delay: null })
      const onChange = vi.fn<(host: Host | null) => void>()
      const onSubmit = vi.fn<(event: FormEvent) => void>((event) => event.preventDefault())
      const view = (props: object) => (
        <form onSubmit={onSubmit}>
          <Field label="Host">
            <Combobox
              value={null}
              onChange={onChange}
              options={HOSTS}
              getOptionKey={(host) => host.id}
              getOptionLabel={(host) => host.full_name}
              {...props}
            />
          </Field>
        </form>
      )
      const { rerender } = render(view(statusProps))
      const input = screen.getByRole('combobox', { name: 'Host' })

      await user.type(input, 'li')
      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

      expect(screen.getByRole('status')).toHaveTextContent(statusText)
      expect(screen.queryAllByRole('option')).toHaveLength(0)
      expect(input).not.toHaveAttribute('aria-activedescendant')
      expect(onChange).not.toHaveBeenCalled()
      // Enter on an open popup is not a form submission either.
      expect(onSubmit).not.toHaveBeenCalled()
      expect(input).toHaveAttribute('aria-expanded', 'true')

      // Once results show, the earlier key presses have left no active option behind.
      rerender(view({}))
      expect(input).not.toHaveAttribute('aria-activedescendant')
      await user.keyboard('{ArrowDown}')
      expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Lina Haddad' }).id)
    },
  )

  it('clears the active option when the visible list changes', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn<(host: Host | null) => void>()
    const view = (options: Host[]) => (
      <Field label="Host">
        <Combobox
          value={null}
          onChange={onChange}
          options={options}
          getOptionKey={(host) => host.id}
          getOptionLabel={(host) => host.full_name}
        />
      </Field>
    )
    const { rerender } = render(view(HOSTS))
    const input = screen.getByRole('combobox', { name: 'Host' })
    await user.type(input, 'a')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Omar Khalil' }).id)

    rerender(view([HOSTS[2]!, HOSTS[1]!]))
    expect(input).not.toHaveAttribute('aria-activedescendant')
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()

    // Re-rendering the same list (new array, same options) keeps the user's place.
    await user.keyboard('{ArrowDown}')
    rerender(view([HOSTS[2]!, HOSTS[1]!]))
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Élodie Martin' }).id)
  })

  it('opens the full list on click with the selected option active, and filters once the user types', async () => {
    const user = userEvent.setup({ delay: null })
    const queries: string[] = []
    function SelectedHostPicker() {
      const [value, setValue] = useState<Host | null>(HOSTS[1]!)
      const [query, setQuery] = useState('')
      const options = HOSTS.filter((host) => host.full_name.toLowerCase().includes(query.trim().toLowerCase()))
      return (
        <Field label="Host">
          <Combobox
            value={value}
            onChange={setValue}
            options={options}
            onQueryChange={(next) => {
              queries.push(next)
              setQuery(next)
            }}
            getOptionKey={(host) => host.id}
            getOptionLabel={(host) => host.full_name}
            renderOption={(host, filter) => `${host.full_name} [${filter}]`}
          />
        </Field>
      )
    }
    render(<SelectedHostPicker />)
    const input = screen.getByRole('combobox', { name: 'Host' })
    expect(input).toHaveValue('Omar Khalil')

    await user.click(input)

    // The selected label is not a filter: every host is listed, the current one active.
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(queries).toEqual([''])
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /^Omar Khalil/ }).id)
    expect(input).toHaveValue('Omar Khalil')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(input).toHaveValue('Élodie Martin')

    // Typing filters, and the filter text reaches renderOption (e.g. to highlight it).
    await user.clear(input)
    await user.type(input, 'lin')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Lina Haddad [lin]'])
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('shows the new label of the same selection once its record loads, unless the user is typing over it', async () => {
    const user = userEvent.setup({ delay: null })
    const loading: Host = { id: 'h2', full_name: 'Loading host…', phone: null, department: null }
    const view = (value: Host) => (
      <Field label="Host">
        <Combobox value={value} onChange={() => {}} options={HOSTS} getOptionKey={(host) => host.id} getOptionLabel={(host) => host.full_name} />
      </Field>
    )
    const { rerender } = render(view(loading))
    const input = screen.getByRole('combobox', { name: 'Host' })
    expect(input).toHaveValue('Loading host…')
    rerender(view(HOSTS[1]!))
    expect(input).toHaveValue('Omar Khalil')

    await user.clear(input)
    await user.type(input, 'Lin')
    rerender(view({ ...HOSTS[1]!, full_name: 'Omar K. Khalil' }))
    expect(input).toHaveValue('Lin')
  })

  it('gives its "Show options" toggle a 44 px target, at the end of the field in either direction', () => {
    render(
      <Field label="Host">
        <Combobox value={null} onChange={() => {}} options={HOSTS} getOptionKey={(host) => host.id} getOptionLabel={(host) => host.full_name} />
      </Field>,
    )
    // The control is 44 px tall; the toggle is as wide, and the text keeps clear of it (logical sides).
    const toggle = screen.getByRole('button', { name: 'Show options', hidden: true })
    expect(toggle.className).toContain('w-11')
    expect(toggle.className).toContain('end-0')
    expect(screen.getByRole('combobox', { name: 'Host' }).className).toContain('pe-11')
    expect(screen.getByRole('combobox', { name: 'Host' }).className).toContain('min-h-11')
  })

  it('as a search box shows a magnifier, has no toggle, and opens when the user types', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <Field label="Returning visitor">
        <Combobox
          variant="search"
          value={null}
          onChange={() => {}}
          options={HOSTS}
          getOptionKey={(host) => host.id}
          getOptionLabel={(host) => host.full_name}
        />
      </Field>,
    )
    const input = screen.getByRole('combobox', { name: 'Returning visitor' })
    expect(screen.queryByRole('button', { name: 'Show options' })).toBeNull()

    await user.click(input)
    expect(input).toHaveAttribute('aria-expanded', 'false')
    await user.type(input, 'o')
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes its popup on Escape without closing a surrounding dialog', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <Dialog open onClose={() => {}} title="Walk-in">
        <HostPicker />
      </Dialog>,
    )
    const input = screen.getByRole('combobox', { name: 'Host' })
    await user.type(input, 'o')
    expect(input).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')

    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('dialog', { name: 'Walk-in' })).toBeInTheDocument()
  })
})

describe('AsyncCombobox', () => {
  it('loads options from the API for the debounced query and supports selection', async () => {
    const user = userEvent.setup({ delay: null })
    const fetchOptions = vi.fn<(query: string) => Promise<Host[]>>(async (query) =>
      HOSTS.filter((host) => host.full_name.toLowerCase().includes(query.toLowerCase())),
    )
    const onChange = vi.fn<(host: Host | null) => void>()
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Field label="Host">
          <AsyncCombobox<Host>
            value={null}
            onChange={onChange}
            queryKey={(q) => ['users', 'hosts', { q }]}
            fetchOptions={(q) => fetchOptions(q)}
            getOptionKey={(host) => host.id}
            getOptionLabel={(host) => host.full_name}
            debounceMs={10}
          />
        </Field>
      </QueryClientProvider>,
    )
    const input = screen.getByRole('combobox', { name: 'Host' })

    await user.type(input, 'mart')

    expect(await screen.findByRole('option', { name: 'Élodie Martin' })).toBeInTheDocument()
    await waitFor(() => expect(fetchOptions).toHaveBeenLastCalledWith('mart'))
    expect(fetchOptions).not.toHaveBeenCalledWith('m')

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith(HOSTS[2])
  })

  it('selects nothing on ArrowDown + Enter typed before the new results arrive', async () => {
    const user = userEvent.setup({ delay: null })
    const pending = new Map<string, ReturnType<typeof deferred<Host[]>>>()
    const fetchOptions = (query: string) => {
      const request = deferred<Host[]>()
      pending.set(query, request)
      return request.promise
    }
    const onChange = vi.fn<(host: Host | null) => void>()
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Field label="Host">
          <AsyncCombobox<Host>
            value={null}
            onChange={onChange}
            queryKey={(q) => ['users', 'hosts', { q }]}
            fetchOptions={fetchOptions}
            getOptionKey={(host) => host.id}
            getOptionLabel={(host) => host.full_name}
            minQueryLength={1}
            debounceMs={10}
          />
        </Field>
      </QueryClientProvider>,
    )
    const input = screen.getByRole('combobox', { name: 'Host' })
    await user.type(input, 'o')
    await waitFor(() => expect(pending.has('o')).toBe(true))
    pending.get('o')!.resolve([HOSTS[1]!, HOSTS[2]!])
    expect(await screen.findByRole('option', { name: 'Omar Khalil' })).toBeVisible()

    // The previous matches stay in memory while "ol" loads, but are not shown or reachable.
    await user.type(input, 'l')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(onChange).not.toHaveBeenCalled()

    await waitFor(() => expect(pending.has('ol')).toBe(true))
    pending.get('ol')!.resolve([HOSTS[2]!])
    expect(await screen.findByRole('option', { name: 'Élodie Martin' })).toBeVisible()
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveValue('ol')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith(HOSTS[2])
  })

  it('asks for more characters before searching when a minimum length is set', async () => {
    const user = userEvent.setup({ delay: null })
    const fetchOptions = vi.fn<() => Promise<Host[]>>(async () => HOSTS)
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Field label="Visitor">
          <AsyncCombobox<Host>
            value={null}
            onChange={() => {}}
            queryKey={(q) => ['visitors', 'search', { q }]}
            fetchOptions={fetchOptions}
            getOptionKey={(host) => host.id}
            getOptionLabel={(host) => host.full_name}
            minQueryLength={2}
            debounceMs={10}
          />
        </Field>
      </QueryClientProvider>,
    )

    await user.type(screen.getByRole('combobox', { name: 'Visitor' }), 'a')

    expect(screen.getByRole('status')).toHaveTextContent('Type at least 2 characters to search.')
    expect(fetchOptions).not.toHaveBeenCalled()
  })
})
