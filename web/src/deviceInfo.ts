/** Грубый парсинг User-Agent для читаемой строки — без зависимостей, ровно
 * те платформы/браузеры, что реально встретятся. Используется и в списке
 * «Активные сеансы» (SettingsModal), и на экране подтверждения QR-входа
 * (QrLoginConfirm) — оба показывают человеку "это устройство/браузер",
 * дублировать разбор незачем. */
export function describeUserAgent(ua: string): string {
  if (!ua) return 'Неизвестное устройство'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPad/.test(ua)
      ? 'iPadOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPod/.test(ua)
            ? 'iOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'неизвестная ОС'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'браузер'
  return `${browser} · ${os}`
}
