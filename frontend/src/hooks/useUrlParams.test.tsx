import { screen } from '@testing-library/react'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'react-router'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../api/queryKeys'
import { makeMe } from '../test/api'
import { createTestQueryClient, recordAddresses, renderRoutes } from '../test/render'
import type { Me } from '../types/api'
import { backLinkState, useBackLink, useBackLinkToHere } from './useBackLink'
import { pageParamValue, readDateParam, readEnumParam, readPageParam, readUuidParam, useUrlParams } from './useUrlParams'

const LINA = makeMe(['EMPLOYEE'])
const OMAR = makeMe(['EMPLOYEE'], { id: '7f0d1c0e-1111-4a5b-9c1d-0000000000f2', full_name: 'Omar Khalil' })

/** A query client whose session is `me`. */
function signedInAs(me: Me) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.me, me)
  return queryClient
}

function readPage(query: string) {
  return readPageParam(new URLSearchParams(query))
}

function ParamsProbe() {
  const [params, update] = useUrlParams()
  const [, setRenders] = useState(0)
  return (
    <>
      <p>{params.toString()}</p>
      <button type="button" onClick={() => update({ tab: 'upcoming', page: null, q: '' })}>
        Apply
      </button>
      <button type="button" onClick={() => update({ q: 'jane.doe@corp.example', page: null })}>
        Search
      </button>
      <button type="button" onClick={() => update({ page: '2' })}>
        Page 2
      </button>
      <button
        type="button"
        onClick={() => {
          update({ tab: 'past' })
          update({ q: 'orbit' })
        }}
      >
        Twice
      </button>
      <button
        type="button"
        onClick={() => {
          update({ tab: 'past' })
          // Another render before the navigation is committed (e.g. data arriving).
          flushSync(() => setRenders((count) => count + 1))
          update({ q: 'orbit' })
        }}
      >
        Twice with a render between
      </button>
      <Link to="/visits/1">Open</Link>
    </>
  )
}

function HereProbe() {
  const back = useBackLinkToHere('Back to Visitors')
  return <p>{JSON.stringify(backLinkState(back))}</p>
}

function BackLinkProbe() {
  const back = useBackLink({ to: '/visits', label: 'Back to My visits' })
  return <a href={back.to}>{back.label}</a>
}

describe('URL parameter helpers', () => {
  it('reads a positive page number, defaulting to 1', () => {
    expect(readPage('page=3')).toBe(3)
    expect(readPage('')).toBe(1)
    expect(readPage('page=0')).toBe(1)
    expect(readPage('page=-2')).toBe(1)
    expect(readPage('page=2.5')).toBe(1)
    expect(readPage('page=abc')).toBe(1)
    expect(readPage('page=99999999')).toBe(1)
    expect(pageParamValue(1)).toBeNull()
    expect(pageParamValue(4)).toBe('4')
  })

  it('reads an allowed value or falls back', () => {
    const tabs = ['today', 'past'] as const
    expect(readEnumParam(new URLSearchParams('tab=past'), 'tab', tabs, 'today')).toBe('past')
    expect(readEnumParam(new URLSearchParams('tab=admin'), 'tab', tabs, 'today')).toBe('today')
  })

  it('applies several changes in one navigation', async () => {
    const { router, user } = renderRoutes([{ path: '/visits', element: <ParamsProbe /> }], {
      initialEntries: ['/visits?tab=past&page=3&q=x'],
    })

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(router.state.location.search).toBe('?tab=upcoming')
    expect(screen.getByText('tab=upcoming')).toBeInTheDocument()
  })

  it('applies two calls in the same tick on top of each other', async () => {
    const { router, user } = renderRoutes([{ path: '/visits', element: <ParamsProbe /> }], {
      initialEntries: ['/visits'],
      queryClient: signedInAs(LINA),
    })

    await user.click(screen.getByRole('button', { name: 'Twice' }))

    expect(router.state.location.search).toBe('?tab=past')
    expect(screen.getByText('tab=past&q=orbit')).toBeInTheDocument()
  })

  it('builds on a change whose navigation another render has not shown yet', async () => {
    const { router, user } = renderRoutes([{ path: '/visits', element: <ParamsProbe /> }], {
      initialEntries: ['/visits'],
      queryClient: signedInAs(LINA),
    })

    await user.click(screen.getByRole('button', { name: 'Twice with a render between' }))

    expect(await screen.findByText('tab=past&q=orbit')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?tab=past')
  })
})

describe('private parameters (SEC-20, SEC-27)', () => {
  const routes = [
    { path: '/visits', element: <ParamsProbe /> },
    { path: '/visits/1', element: <p>Visit</p> },
  ]

  it('keeps the search text out of the address and restores it with the back button', async () => {
    const { router, user } = renderRoutes(routes, { initialEntries: ['/visits?tab=past'], queryClient: signedInAs(LINA) })
    const addresses = recordAddresses(router)

    await user.click(screen.getByRole('button', { name: 'Search' }))

    // The search applies, but the address (and so the browser's saved history) never has it.
    expect(screen.getByText('tab=past&q=jane.doe%40corp.example')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?tab=past')
    expect(router.state.location.state).toEqual({ view: { owner: LINA.user.id, values: { q: 'jane.doe@corp.example' } } })

    // Other changes keep it.
    await user.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(router.state.location.search).toBe('?tab=past&page=2')
    expect(screen.getByText('tab=past&page=2&q=jane.doe%40corp.example')).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Open' }))
    expect(await screen.findByText('Visit')).toBeInTheDocument()
    await router.navigate(-1)
    expect(await screen.findByText('tab=past&page=2&q=jane.doe%40corp.example')).toBeInTheDocument()
    // Not even for a moment.
    expect(addresses.length).toBeGreaterThan(2)
    expect(addresses.filter((address) => address.includes('q='))).toEqual([])
  })

  it('moves a search text from a link of an earlier version out of the address', async () => {
    const { router } = renderRoutes(routes, { initialEntries: ['/visits?tab=past&q=orbit&page=3'], queryClient: signedInAs(LINA) })

    expect(await screen.findByText('tab=past&page=3&q=orbit')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?tab=past&page=3')
    expect(router.state.location.state).toEqual({ view: { owner: LINA.user.id, values: { q: 'orbit' } } })
  })

  it('ignores a search text that another user left in the tab’s history', () => {
    const state = { view: { owner: LINA.user.id, values: { q: 'jane.doe@corp.example' } } }
    renderRoutes(routes, { initialEntries: [{ pathname: '/visits', search: '?tab=past', state }], queryClient: signedInAs(OMAR) })

    expect(screen.getByText('tab=past')).toBeInTheDocument()
    expect(screen.queryByText(/jane/)).toBeNull()
  })

  it('keeps a back link handed to the page when the page changes its parameters', async () => {
    const state = backLinkState({ to: '/visitors?page=2', label: 'Back to Visitors', owner: LINA.user.id })
    const { router, user } = renderRoutes(routes, { initialEntries: [{ pathname: '/visits', state }], queryClient: signedInAs(LINA) })

    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(router.state.location.state).toMatchObject(state)
  })
})

describe('readDateParam and readUuidParam', () => {
  it('read a calendar date, ignoring impossible or malformed ones', () => {
    expect(readDateParam(new URLSearchParams('from=2026-10-05'), 'from')).toBe('2026-10-05')
    expect(readDateParam(new URLSearchParams('from=2026-02-30'), 'from')).toBeNull()
    expect(readDateParam(new URLSearchParams('from=yesterday'), 'from')).toBeNull()
    expect(readDateParam(new URLSearchParams(''), 'from')).toBeNull()
  })

  it('read a record ID, lower-cased and trimmed, ignoring anything that is not one', () => {
    const id = '7f0d1c0e-1111-4a5b-9c1d-0000000000ab'
    expect(readUuidParam(new URLSearchParams({ host: ` ${id.toUpperCase()} ` }), 'host')).toBe(id)
    expect(readUuidParam(new URLSearchParams({ host: '42' }), 'host')).toBeNull()
    expect(readUuidParam(new URLSearchParams(''), 'host')).toBeNull()
  })
})

describe('useBackLink', () => {
  const owner = LINA.user.id
  it.each([
    [backLinkState({ to: '/visits?tab=past', label: 'Back to My visits', owner }), '/visits?tab=past'],
    [backLinkState({ to: '//evil.example', label: 'Back', owner }), '/visits'],
    [backLinkState({ to: 'https://evil.example', label: 'Back', owner }), '/visits'],
    [backLinkState({ to: '/\\evil.example', label: 'Back', owner }), '/visits'],
    [{ backLink: { to: 3 } }, '/visits'],
    [null, '/visits'],
  ])('uses the handed-over in-app path or the fallback (%j)', (state, expected) => {
    renderRoutes([{ path: '*', element: <BackLinkProbe /> }], { initialEntries: [{ pathname: '/visits/1', state }], queryClient: signedInAs(LINA) })
    expect(screen.getByRole('link')).toHaveAttribute('href', expected)
  })

  it('ignores a back link that another user’s session left in the tab’s history (SEC-28)', () => {
    const state = backLinkState({ to: '/visitors/42', label: 'Back to visitor profile', owner })
    renderRoutes([{ path: '*', element: <BackLinkProbe /> }], { initialEntries: [{ pathname: '/visits/1', state }], queryClient: signedInAs(OMAR) })

    expect(screen.getByRole('link')).toHaveAttribute('href', '/visits')
    expect(screen.getByRole('link')).toHaveTextContent('Back to My visits')
  })

  it('hands over the current page with the state that restores its view', () => {
    const view = { view: { owner, values: { q: 'orbit' } } }
    renderRoutes([{ path: '*', element: <HereProbe /> }], {
      initialEntries: [{ pathname: '/visitors', search: '?page=2', state: view }],
      queryClient: signedInAs(LINA),
    })

    expect(JSON.parse(screen.getByRole('paragraph').textContent ?? '')).toEqual({
      backLink: { to: '/visitors?page=2', label: 'Back to Visitors', state: view, owner },
    })
  })
})
