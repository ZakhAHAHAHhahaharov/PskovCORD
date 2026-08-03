import { useEffect, useState } from 'react'
import { Download, FileText, X } from 'lucide-react'
import { Attachment, mediaUrl } from '../api'
import VoiceMessage from './VoiceMessage'

/**
 * Отрисовка вложений сообщения.
 *
 * Решение «встраивать или дать скачать» принимается ТОЛЬКО по content_type,
 * который проставил сервер по содержимому файла — не по расширению имени и не
 * по тому, что прислал загружающий (см. backend chat/uploads.py). Всё, что не
 * опознано как безопасное для встраивания, приезжает как
 * application/octet-stream и показывается карточкой со скачиванием.
 */

const MAX_PREVIEW_W = 420
const MAX_PREVIEW_H = 320

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

/** Размер места под картинку ДО её загрузки — чтобы лента не прыгала, когда
 * картинка догрузится (сервер отдаёт width/height, см. Attachment). */
function previewBox(a: Attachment): { width: number; height: number } | undefined {
  if (!a.width || !a.height) return undefined
  const scale = Math.min(MAX_PREVIEW_W / a.width, MAX_PREVIEW_H / a.height, 1)
  return { width: Math.round(a.width * scale), height: Math.round(a.height * scale) }
}

function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <img
        className="lightbox-image"
        src={mediaUrl(attachment.url)}
        alt={attachment.original_name}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{attachment.original_name}</span>
        <a
          className="lightbox-action"
          href={mediaUrl(attachment.url)}
          download={attachment.original_name}
        >
          <Download size={15} /> Скачать
        </a>
        <button className="lightbox-action" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

export default function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const [zoomed, setZoomed] = useState<Attachment | null>(null)
  if (!attachments.length) return null

  return (
    <div className="message-attachments">
      {attachments.map((a) => {
        const url = mediaUrl(a.url)

        if (a.content_type.startsWith('image/')) {
          const box = previewBox(a)
          return (
            <button
              key={a.id}
              type="button"
              className="attachment-image-btn"
              onClick={() => setZoomed(a)}
              title={`${a.original_name} · ${formatSize(a.size)}`}
            >
              <img
                className="attachment-image"
                src={url}
                alt={a.original_name}
                width={box?.width}
                height={box?.height}
                // Картинки ниже видимой области не грузим: в открытом канале
                // с длинной историей их могут быть десятки.
                loading="lazy"
              />
            </button>
          )
        }

        if (a.content_type.startsWith('video/')) {
          return (
            <video key={a.id} className="attachment-video" src={url} controls preload="metadata" />
          )
        }

        // Голосовое — свой плеер с дорожкой; обычный присланный аудиофайл —
        // штатные controls браузера. Различает их флаг voice, проставленный
        // при загрузке (см. backend AttachmentUpload), а не content_type:
        // и то, и другое — audio/*, но ведут себя они по-разному, и голосовое
        // вдобавок режется собственным правом.
        if (a.voice) {
          return <VoiceMessage key={a.id} attachment={a} />
        }

        if (a.content_type.startsWith('audio/')) {
          return (
            <div key={a.id} className="attachment-audio">
              <span className="attachment-name">{a.original_name}</span>
              <audio src={url} controls preload="metadata" />
            </div>
          )
        }

        return (
          <a
            key={a.id}
            className="attachment-file"
            href={url}
            download={a.original_name}
            // Файл лежит на том же домене, но отдаётся с
            // Content-Disposition: attachment (см. deploy/nginx.conf.example).
            // noopener на всякий случай: ссылка ведёт на пользовательский
            // контент, и открывающая страница не должна быть ему доступна.
            rel="noopener noreferrer"
          >
            <FileText size={20} className="attachment-file-icon" />
            <span className="attachment-file-info">
              <span className="attachment-file-name">{a.original_name}</span>
              <span className="attachment-file-size">{formatSize(a.size)}</span>
            </span>
            <Download size={16} className="attachment-file-download" />
          </a>
        )
      })}

      {zoomed && <Lightbox attachment={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  )
}
