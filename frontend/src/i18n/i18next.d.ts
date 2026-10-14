import type { resources } from './resources'

/*
 * Type-safe keys: `t('nav.open')` and `t('errors:codes.NOT_FOUND')` are checked against the
 * English catalogs, so a missing or misspelt key fails `npm run typecheck`. Plural keys are
 * written without their suffix (`t('combobox.results', { count })`).
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: (typeof resources)['en']
    returnNull: false
  }
}
