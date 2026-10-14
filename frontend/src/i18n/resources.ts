import arAdmin from './locales/ar/admin.json'
import arAuth from './locales/ar/auth.json'
import arCommon from './locales/ar/common.json'
import arErrors from './locales/ar/errors.json'
import arHistory from './locales/ar/history.json'
import arInside from './locales/ar/inside.json'
import arPass from './locales/ar/pass.json'
import arPlatform from './locales/ar/platform.json'
import arReception from './locales/ar/reception.json'
import arReports from './locales/ar/reports.json'
import arVisitors from './locales/ar/visitors.json'
import arVisits from './locales/ar/visits.json'
import enAdmin from './locales/en/admin.json'
import enAuth from './locales/en/auth.json'
import enCommon from './locales/en/common.json'
import enErrors from './locales/en/errors.json'
import enHistory from './locales/en/history.json'
import enInside from './locales/en/inside.json'
import enPass from './locales/en/pass.json'
import enPlatform from './locales/en/platform.json'
import enReception from './locales/en/reception.json'
import enReports from './locales/en/reports.json'
import enVisitors from './locales/en/visitors.json'
import enVisits from './locales/en/visits.json'

/**
 * One namespace per area of the app (F10-2). `common` holds the shell and the UI kit, `errors`
 * the message of every API error code, `auth` the sign-in chrome; each feature fills its own.
 */
export const NAMESPACES = ['common', 'errors', 'auth', 'reception', 'visits', 'visitors', 'history', 'inside', 'reports', 'admin', 'pass', 'platform'] as const

export type Namespace = (typeof NAMESPACES)[number]

/**
 * Both languages are bundled: together they are a few kilobytes now, and switching or starting in
 * either language never waits for a download (the app also runs from the service worker's cache).
 * English is the source of the key types (`i18next.d.ts`); `catalogs.test.ts` requires every key
 * in Arabic too, with all six Arabic plural forms.
 */
export const resources = {
  en: {
    common: enCommon,
    errors: enErrors,
    auth: enAuth,
    reception: enReception,
    visits: enVisits,
    visitors: enVisitors,
    history: enHistory,
    inside: enInside,
    reports: enReports,
    admin: enAdmin,
    pass: enPass,
    platform: enPlatform,
  },
  ar: {
    common: arCommon,
    errors: arErrors,
    auth: arAuth,
    reception: arReception,
    visits: arVisits,
    visitors: arVisitors,
    history: arHistory,
    inside: arInside,
    reports: arReports,
    admin: arAdmin,
    pass: arPass,
    platform: arPlatform,
  },
} as const
