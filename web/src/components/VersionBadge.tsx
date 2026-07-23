import { APP_VERSION } from '../version'

export default function VersionBadge() {
  return (
    <div className="version-badge">
      v{APP_VERSION.version} · {APP_VERSION.note}
    </div>
  )
}
