const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'PskovCord'

/**
 * Неизвестный путь — приложение не роутится по URL вообще (см. qrToken.ts:
 * единственный особый путь — /qr-login/:token), поэтому любой другой путь,
 * кроме "/", раньше молча открывал обычный чат, будто ссылка была рабочей.
 * Бэкенд (core.views.spa) отдаёт index.html на любой путь безусловно — это
 * нормально для SPA (роутинг клиентский), но сам клиент до этого никак не
 * отличал "неизвестный путь" от корня. См. App.tsx.
 */
export default function NotFoundScreen() {
  return (
    <div className="login-bg">
      <div className="login-card not-found-card">
        <h1 className="login-logo">{APP_NAME}</h1>
        <div className="not-found-code">404</div>
        <p className="login-sub">Такой страницы нет — возможно, ссылка устарела или введена неверно.</p>
        <a className="btn-primary not-found-home-link" href="/">
          Вернуться в приложение
        </a>
      </div>
    </div>
  )
}
