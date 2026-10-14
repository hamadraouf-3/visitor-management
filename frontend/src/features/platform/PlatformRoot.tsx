import { Outlet } from 'react-router'
import { PlatformAuthProvider, PlatformLanguageController } from './PlatformAuthProvider'

/** Every `/platform` page, signed in or not: the platform session's reactions and language. */
export function PlatformRoot() {
  return (
    <PlatformAuthProvider>
      <PlatformLanguageController />
      <Outlet />
    </PlatformAuthProvider>
  )
}
