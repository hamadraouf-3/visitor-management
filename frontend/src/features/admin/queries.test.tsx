import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../../api/queryKeys'
import { jsonResponse, mockApi } from '../../test/api'
import { LEGAL } from '../../test/fixtures'
import { createTestQueryClient } from '../../test/render'
import type { Department, User } from '../../types/api'
import { useUpdateDepartment, useUpdateUser } from './queries'
import { makeUser } from './testRoutes'

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

/** The query keys invalidated, as JSON, so prefixes can be compared. */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => JSON.stringify((args[0] as { queryKey?: unknown } | undefined)?.queryKey))
}

const key = (queryKey: readonly unknown[]) => JSON.stringify(queryKey)

describe('admin mutations refresh what a visit change touches (FX-5)', () => {
  it('after a deactivation cancelled the user’s visits (D-18): reception lists and visitor searches too', async () => {
    const user = makeUser()
    mockApi({ [`PATCH /users/${user.id}`]: () => jsonResponse({ ...user, is_active: false, cancelled_visits: 2 } satisfies User) })
    const queryClient = createTestQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateUser(user.id, false), { wrapper: wrapperFor(queryClient) })

    await act(() => result.current.mutateAsync({ is_active: false }))

    const keys = invalidatedKeys(invalidate)
    for (const expected of [queryKeys.visitors.all, queryKeys.reception.all, queryKeys.visits.all, queryKeys.dashboard.employee, queryKeys.dashboard.admin]) {
      expect(keys).toContain(key(expected))
    }
  })

  it('leaves visit screens alone when nothing was cancelled', async () => {
    const user = makeUser()
    mockApi({ [`PATCH /users/${user.id}`]: () => jsonResponse({ ...user, full_name: 'Omar K. Khalil' } satisfies User) })
    const queryClient = createTestQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateUser(user.id, false), { wrapper: wrapperFor(queryClient) })

    await act(() => result.current.mutateAsync({ full_name: 'Omar K. Khalil' }))

    expect(invalidatedKeys(invalidate)).not.toContain(key(queryKeys.reception.all))
  })

  it('after a department rename (D-17): reception lists and visitor searches show the new name', async () => {
    const renamed: Department = { ...LEGAL, name: 'Legal Affairs' }
    mockApi({ [`PATCH /departments/${LEGAL.id}`]: () => jsonResponse(renamed) })
    const queryClient = createTestQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useUpdateDepartment(), { wrapper: wrapperFor(queryClient) })

    await act(() => result.current.mutateAsync({ id: LEGAL.id, body: { name: 'Legal Affairs' } }))

    const keys = invalidatedKeys(invalidate)
    for (const expected of [queryKeys.departments.all, queryKeys.visitors.all, queryKeys.reception.all, queryKeys.visits.all, queryKeys.me]) {
      expect(keys).toContain(key(expected))
    }
  })
})
