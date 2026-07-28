const QR_LOGIN_PATH_RE = /^\/qr-login\/([^/]+)\/?$/

function parseQrLoginPath(pathname: string): string | null {
  const m = pathname.match(QR_LOGIN_PATH_RE)
  return m ? decodeURIComponent(m[1]) : null
}

/** Нет react-router — вся "маршрутизация" в приложении это этот один путь,
 * точечный разбор pathname проще, чем тащить целый роутер ради одного
 * экрана (см. App.tsx). */
export function parseQrLoginToken(): string | null {
  return parseQrLoginPath(window.location.pathname)
}

/** То же самое, но из текста, который вернул сканер камеры (см.
 * QrScannerModal) — это может быть как полный URL с других хоста/порта
 * (dev), так и просто путь. */
export function parseQrLoginText(text: string): string | null {
  try {
    return parseQrLoginPath(new URL(text).pathname)
  } catch {
    return parseQrLoginPath(text)
  }
}
