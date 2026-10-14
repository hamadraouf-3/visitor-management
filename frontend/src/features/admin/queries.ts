import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listAuditLogs } from '../../api/auditLogs'
import { updateCompanySettings } from '../../api/company'
import { getAdminDashboard } from '../../api/dashboard'
import { createDepartment, listDepartments, updateDepartment } from '../../api/departments'
import { queryKeys } from '../../api/queryKeys'
import { createUser, getUser, listUsers, updateUser } from '../../api/users'
import { refreshAfterVisitChange } from '../visits/queries'
import { useEmailTemplatesSource } from './emailTemplatesSource'
import type {
  AuditLogListParams,
  CompanySettingsUpdate,
  DepartmentCreate,
  DepartmentUpdate,
  EmailTemplate,
  EmailTemplateKind,
  EmailTemplatePreviewRequest,
  EmailTemplateUpdate,
  UserCreate,
  UserListParams,
  UserUpdate,
} from '../../types/api'

/** Polled while the dashboard is open (every 30 s, paused in a background tab): its people-inside figure is shown as live. */
export const ADMIN_DASHBOARD_REFRESH_MS = 30_000

export function useAdminDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard.admin,
    queryFn: ({ signal }) => getAdminDashboard({ signal }),
    refetchInterval: ADMIN_DASHBOARD_REFRESH_MS,
  })
}

/* Users ------------------------------------------------------------------------------------- */

export function useUserList(params: UserListParams) {
  return useQuery({
    queryKey: queryKeys.users.list(params),
    queryFn: ({ signal }) => listUsers(params, { signal }),
    placeholderData: keepPreviousData,
  })
}

/**
 * One account by ID (GET /users/{id}, administrators), e.g. the name of the audit log's
 * "Performed by" filter. Not retried: an ID that is not a user of the company stays unknown. A
 * record just picked from a search is put in the cache and used as it is for a minute.
 */
export function useUser(id: string | null) {
  return useQuery({
    queryKey: queryKeys.users.detail(id ?? ''),
    queryFn: ({ signal }) => getUser(id ?? '', { signal }),
    enabled: id !== null,
    retry: false,
    staleTime: 60_000,
  })
}

/**
 * Creates a user with a temporary password. `gcTime: 0`: the request body (with the password)
 * leaves the mutation cache as soon as the dialog that sent it closes.
 */
export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UserCreate) => createUser(body),
    gcTime: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.admin })
    },
  })
}

/**
 * Updates a user. A deactivation or a lost host role may cancel the user's scheduled visits
 * (D-18), so visit lists, counts and reception screens are refreshed too; editing oneself
 * refreshes the session's own profile.
 */
export function useUpdateUser(userId: string, isSelf: boolean) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UserUpdate) => updateUser(userId, body),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.users.detail(user.id), user)
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.admin })
      if (user.cancelled_visits) {
        // D-18 cancelled the user's scheduled visits: the one refresh after a visit change (FX-5),
        // visitor searches included ("Find a visitor" offered them as actionable), plus their details.
        refreshAfterVisitChange(queryClient)
        void queryClient.invalidateQueries({ queryKey: queryKeys.visits.all })
      }
      if (isSelf) void queryClient.invalidateQueries({ queryKey: queryKeys.me })
    },
  })
}

/* Departments ------------------------------------------------------------------------------- */

/** Every department including inactive ones (administrators only, B1-19). */
export function useAllDepartments() {
  return useQuery({
    queryKey: queryKeys.departments.list({ include_inactive: true }),
    queryFn: ({ signal }) => listDepartments({ include_inactive: true }, { signal }),
  })
}

/**
 * After a department change: every department list, the users that show its name, everything
 * that shows visits (a rename refreshes scheduled visits, D-17: the one refresh after a visit
 * change, reception lists and visitor searches included, plus the visits' details) and the
 * session's profile (its own department).
 */
function useRefreshAfterDepartmentChange() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.departments.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.all })
    refreshAfterVisitChange(queryClient)
    void queryClient.invalidateQueries({ queryKey: queryKeys.visits.all })
    void queryClient.invalidateQueries({ queryKey: queryKeys.me })
  }
}

export function useCreateDepartment() {
  const refresh = useRefreshAfterDepartmentChange()
  return useMutation({ mutationFn: (body: DepartmentCreate) => createDepartment(body), onSuccess: refresh })
}

export function useUpdateDepartment() {
  const refresh = useRefreshAfterDepartmentChange()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DepartmentUpdate }) => updateDepartment(id, body),
    onSuccess: refresh,
  })
}

/* Company settings -------------------------------------------------------------------------- */

/** Saves settings; the company name and time zone in the session (`Me`) follow. */
export function useUpdateCompanySettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CompanySettingsUpdate) => updateCompanySettings(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.companySettings, settings)
      void queryClient.invalidateQueries({ queryKey: queryKeys.me })
    },
  })
}

/* Audit log --------------------------------------------------------------------------------- */

export function useAuditLogs(params: AuditLogListParams | null) {
  return useQuery({
    queryKey: queryKeys.auditLogs.list(params ?? {}),
    queryFn: ({ signal }) => listAuditLogs(params ?? {}, { signal }),
    enabled: params !== null,
    placeholderData: keepPreviousData,
  })
}

/* E-mail texts (Phase 11) ------------------------------------------------------------------------ */

/*
 * Each hook works on the source its page provides (`emailTemplatesSource.ts`): the company's own
 * endpoints for its administrator, the same ones under a company for the platform owner (Phase 12).
 */

export function useEmailTemplates() {
  const source = useEmailTemplatesSource()
  return useQuery({
    queryKey: source.keys.list,
    queryFn: ({ signal }) => source.api.list({ signal }),
  })
}

export function useEmailTemplate(kind: EmailTemplateKind) {
  const source = useEmailTemplatesSource()
  return useQuery({
    queryKey: source.keys.detail(kind),
    queryFn: ({ signal }) => source.api.get(kind, { signal }),
  })
}

/** After a save or a reset: the kind's texts as the server answered, and the list's counts. */
function useTemplateSaved() {
  const queryClient = useQueryClient()
  const source = useEmailTemplatesSource()
  return (template: EmailTemplate) => {
    queryClient.setQueryData(source.keys.detail(template.kind), template)
    void queryClient.invalidateQueries({ queryKey: source.keys.list })
  }
}

export function useSaveEmailTemplate(kind: EmailTemplateKind) {
  const saved = useTemplateSaved()
  const source = useEmailTemplatesSource()
  return useMutation({
    mutationKey: source.mutationKey?.('email-template-save'),
    mutationFn: (body: EmailTemplateUpdate) => source.api.update(kind, body),
    onSuccess: saved,
  })
}

/** Back to the default texts, in both languages. */
export function useResetEmailTemplate(kind: EmailTemplateKind) {
  const saved = useTemplateSaved()
  const source = useEmailTemplatesSource()
  return useMutation({ mutationKey: source.mutationKey?.('email-template-reset'), mutationFn: () => source.api.reset(kind), onSuccess: saved })
}

/** The rendering of a draft to the sender's own address (202; 429 after 5 an hour). */
export function useSendTestEmail(kind: EmailTemplateKind) {
  const source = useEmailTemplatesSource()
  return useMutation({
    mutationKey: source.mutationKey?.('email-template-test'),
    mutationFn: (body: EmailTemplatePreviewRequest) => source.api.sendTest(kind, body),
  })
}

/**
 * A draft's rendering (POST preview: nothing is sent or saved), keyed by the request body, the
 * previous one kept on screen while the next loads. `null`: nothing to render (an invalid draft).
 */
export function useEmailTemplatePreview(kind: EmailTemplateKind, body: EmailTemplatePreviewRequest | null) {
  const source = useEmailTemplatesSource()
  return useQuery({
    queryKey: source.keys.preview(kind, body),
    queryFn: ({ signal }) => source.api.preview(kind, body!, { signal }),
    enabled: body !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}
