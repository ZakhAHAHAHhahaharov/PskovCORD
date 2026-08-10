import { useLinkPreview } from '../linkPreview'

/**
 * Карточка под сообщением со ссылкой — заголовок, описание и картинка со
 * страницы (см. backend chat/linkpreview.py).
 *
 * Ничего не показывает, пока превью не приехало, и не занимает под него
 * место заранее: карточка появляется у меньшинства сообщений, а
 * зарезервированная пустота была бы видна у всех остальных.
 */
export default function LinkPreviewCard({ content }: { content: string }) {
  const preview = useLinkPreview(content)
  if (!preview) return null

  return (
    <a
      className="link-preview"
      href={preview.url}
      target="_blank"
      // noreferrer вместе с noopener: без первого целевая страница получает
      // адрес нашего канала в Referer, без второго — доступ к window.opener.
      rel="noopener noreferrer"
    >
      <div className="link-preview-body">
        {preview.site_name && (
          <div className="link-preview-site">{preview.site_name}</div>
        )}
        {preview.title && <div className="link-preview-title">{preview.title}</div>}
        {preview.description && (
          <div className="link-preview-description">{preview.description}</div>
        )}
      </div>
      {preview.image && (
        <img
          className="link-preview-image"
          src={preview.image}
          alt=""
          loading="lazy"
          // Картинка чужая: если она не загрузилась (404, hotlink-защита),
          // прячем именно её, а не всю карточку — текст в ней ценнее.
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
          // Referrer не отдаём и здесь — иначе чужой сервер картинок узнаёт,
          // с какой страницы её тянут.
          referrerPolicy="no-referrer"
        />
      )}
    </a>
  )
}
