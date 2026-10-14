import { describe, expect, it } from 'vitest'
import { DARK_SURFACE_HANDLE } from '../../layouts/shellSurface'
import { receptionFeature } from './routes'

describe('reception route', () => {
  it('asks for the dark surface: direction C’s reception tablet is dark from edge to edge', () => {
    const reception = receptionFeature.routes?.flatMap((route) => route.children ?? []).find((route) => route.path === 'reception')
    expect(reception?.handle).toBe(DARK_SURFACE_HANDLE)
  })
})
