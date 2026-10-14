import { useAuth } from '../../auth/useAuth'
import { useQrDecoderPreload } from '../../scanner/useQrDecoderPreload'
import { ReceptionScreen } from './ReceptionScreen'

/**
 * /reception (lazy route, §10). The QR decoder starts loading as soon as the screen mounts, so
 * the first scan does not wait for the self-hosted wasm. The header lives in the screen, whose
 * "Find a visitor" button opens the search it holds (as the detail pages hold theirs).
 */
export default function ReceptionPage() {
  const decoder = useQrDecoderPreload()
  const { me } = useAuth()
  if (!me) return null
  return <ReceptionScreen me={me} decoder={decoder} />
}
