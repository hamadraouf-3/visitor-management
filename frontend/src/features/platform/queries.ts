import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCompanyAdmin,
  createPlatformCompany,
  deactivatePlatformCompany,
  deleteCompanyBrandAsset,
  getPlatformCompany,
  listCompanyAdmins,
  listPlatformAuditLogs,
  listPlatformCompanies,
  previewBrandPalette,
  reactivatePlatformCompany,
  sendCompanyAdminPasswordReset,
  updateCompanyBrand,
  updatePlatformCompany,
  uploadCompanyBrandAsset,
} from '../../api/platform'
import { queryKeys } from '../../api/queryKeys'
import type { BrandAssetKind } from '../../identity/brand'
import type {
  CompanyAdminCreate,
  CompanyBrand,
  PlatformAuditLogListParams,
  PlatformCompany,
  PlatformCompanyCreate,
  PlatformCompanyListParams,
  PlatformCompanyUpdate,
} from '../../types/api'

/* The platform owner's data (Phase 11). Every key and mutation key is under `queryKeys.platform`. */

const MUTATION = (name: string) => [...queryKeys.platform.all, name] as const

export function usePlatformCompanies(params: PlatformCompanyListParams) {
  return useQuery({
    queryKey: queryKeys.platform.companies.list(params),
    queryFn: ({ signal }) => listPlatformCompanies(params, { signal }),
    placeholderData: keepPreviousData,
  })
}

export function usePlatformCompany(id: string) {
  return useQuery({
    queryKey: queryKeys.platform.companies.detail(id),
    queryFn: ({ signal }) => getPlatformCompany(id, { signal }),
  })
}

/** A company by ID for a label (the audit filter's chip): not retried, quiet when it is not found. */
export function usePlatformCompanyName(id: string | null) {
  return useQuery({
    queryKey: queryKeys.platform.companies.detail(id ?? ''),
    queryFn: ({ signal }) => getPlatformCompany(id ?? '', { signal }),
    enabled: id !== null,
    retry: false,
    staleTime: 60_000,
  })
}

export function useCompanyAdmins(companyId: string) {
  return useQuery({
    queryKey: queryKeys.platform.companies.admins(companyId),
    queryFn: ({ signal }) => listCompanyAdmins(companyId, { signal }),
  })
}

/**
 * Administrators' names by user ID, for the companies given: the platform trail's rows about an
 * administrator ("User created") carry only the company and the user's ID (UX review L12). One
 * request per company, shared with the company's page and kept for a minute; a company that cannot
 * be read leaves its rows as they were.
 */
export function useCompanyAdminNames(companyIds: readonly string[]): ReadonlyMap<string, string> {
  return useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.platform.companies.admins(companyId),
      queryFn: ({ signal }: { signal: AbortSignal }) => listCompanyAdmins(companyId, { signal }),
      staleTime: 60_000,
      retry: false,
    })),
    combine: (results) => {
      const names = new Map<string, string>()
      for (const result of results) for (const admin of result.data ?? []) names.set(admin.id, admin.full_name)
      return names
    },
  })
}

/** After a change to a company: its page and every list (its counts and state show there). */
function useCompanyChanged() {
  const queryClient = useQueryClient()
  return (company: PlatformCompany) => {
    queryClient.setQueryData(queryKeys.platform.companies.detail(company.id), company)
    void queryClient.invalidateQueries({ queryKey: queryKeys.platform.companies.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.platform.auditLogs.all })
  }
}

/**
 * Creates a company and its first administrator. `gcTime: 0`: the request body (with the
 * temporary password) leaves the mutation cache as soon as the page that sent it unmounts.
 */
export function useCreatePlatformCompany() {
  const changed = useCompanyChanged()
  return useMutation({
    mutationKey: MUTATION('create-company'),
    mutationFn: (body: PlatformCompanyCreate) => createPlatformCompany(body),
    gcTime: 0,
    onSuccess: (created) => changed(created.company),
  })
}

export function useUpdatePlatformCompany(id: string) {
  const changed = useCompanyChanged()
  return useMutation({
    mutationKey: MUTATION('update-company'),
    mutationFn: (body: PlatformCompanyUpdate) => updatePlatformCompany(id, body),
    onSuccess: changed,
  })
}

export function useSetCompanyActive(id: string) {
  const changed = useCompanyChanged()
  return useMutation({
    mutationKey: MUTATION('company-active'),
    mutationFn: (active: boolean) => (active ? reactivatePlatformCompany(id) : deactivatePlatformCompany(id)),
    onSuccess: changed,
  })
}

/** Adds an administrator with a temporary password (`gcTime: 0`, as for the company). */
export function useCreateCompanyAdmin(companyId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: MUTATION('create-admin'),
    mutationFn: (body: CompanyAdminCreate) => createCompanyAdmin(companyId, body),
    gcTime: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.companies.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.auditLogs.all })
    },
  })
}

export function useSendAdminPasswordReset(companyId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: MUTATION('admin-password-reset'),
    mutationFn: (userId: string) => sendCompanyAdminPasswordReset(companyId, userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.platform.auditLogs.all }),
  })
}

export function usePlatformAuditLogs(params: PlatformAuditLogListParams) {
  return useQuery({
    queryKey: queryKeys.platform.auditLogs.list(params),
    queryFn: ({ signal }) => listPlatformAuditLogs(params, { signal }),
    placeholderData: keepPreviousData,
  })
}

/* A company's identity (Phase 12) ---------------------------------------------------------------- */

/** After a change to a company's identity: its page shows the new brand, and so do the lists and the audit log. */
function useBrandChanged(companyId: string) {
  const queryClient = useQueryClient()
  return (brand: CompanyBrand) => {
    queryClient.setQueryData<PlatformCompany>(queryKeys.platform.companies.detail(companyId), (company) => (company ? { ...company, brand } : company))
    void queryClient.invalidateQueries({ queryKey: queryKeys.platform.companies.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.platform.auditLogs.all })
  }
}

/** What a save of the identity sends: the prepared PNG of each file that changed, and the colour when it changed. */
export interface IdentityChanges {
  assets: Partial<Record<BrandAssetKind, Blob>>
  /** Left out: unchanged. Null: the default palette. */
  color?: string | null
}

/** One step of a save: a file, or the colour. */
export type IdentityStep = BrandAssetKind | 'color'

/** A save that stopped at a step: the steps before it are saved, this one and the ones after it are not. */
export class IdentitySaveError extends Error {
  readonly step: IdentityStep

  constructor(step: IdentityStep, cause: unknown) {
    super(`Saving the identity stopped at ${step}`, { cause })
    this.name = 'IdentitySaveError'
    this.step = step
  }
}

/** The logo before the icon made from it, then the dark-surface logo, then the colour. */
const ASSET_ORDER: readonly BrandAssetKind[] = ['logo', 'icon', 'logo_dark']

/**
 * Saves the identity: each changed file is uploaded (the API has an endpoint per file), then the
 * colour is set. `onStepSaved` is called after each step with the brand as the server has it, so the
 * page keeps only what is still unsaved when a later step fails (`IdentitySaveError`).
 */
export function useSaveCompanyIdentity(companyId: string, onStepSaved: (step: IdentityStep, brand: CompanyBrand) => void) {
  const changed = useBrandChanged(companyId)
  return useMutation({
    mutationKey: MUTATION('save-identity'),
    mutationFn: async ({ assets, color }: IdentityChanges): Promise<CompanyBrand | null> => {
      let brand: CompanyBrand | null = null
      const step = async (name: IdentityStep, request: () => Promise<CompanyBrand>) => {
        try {
          brand = await request()
        } catch (error) {
          throw new IdentitySaveError(name, error)
        }
        changed(brand)
        onStepSaved(name, brand)
      }
      for (const kind of ASSET_ORDER) {
        const png = assets[kind]
        if (png) await step(kind, () => uploadCompanyBrandAsset(companyId, kind, png))
      }
      if (color !== undefined) await step('color', () => updateCompanyBrand(companyId, { color }))
      return brand
    },
  })
}

/**
 * Removes saved files of a company's identity, one request each, in the order given (the logo, then
 * the icon that goes with it). The page shows the brand as the server has it after every one, so a
 * later failure leaves what was removed removed.
 */
export function useRemoveBrandAssets(companyId: string) {
  const changed = useBrandChanged(companyId)
  return useMutation({
    mutationKey: MUTATION('remove-brand-asset'),
    mutationFn: async (kinds: readonly BrandAssetKind[]) => {
      for (const kind of kinds) changed(await deleteCompanyBrandAsset(companyId, kind))
    },
  })
}

export function useResetBrandColour(companyId: string) {
  const changed = useBrandChanged(companyId)
  return useMutation({
    mutationKey: MUTATION('reset-brand-colour'),
    mutationFn: () => updateCompanyBrand(companyId, { color: null }),
    onSuccess: changed,
  })
}

/**
 * The palette a colour would give (POST /platform/brand/palette: nothing is saved), for the live
 * preview; the previous palette stays on screen while the next one loads. Null: no colour, no request.
 */
export function useBrandPalette(color: string | null) {
  return useQuery({
    queryKey: queryKeys.platform.palette(color ?? ''),
    queryFn: ({ signal }) => previewBrandPalette({ color: color ?? '' }, { signal }),
    enabled: color !== null,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  })
}
