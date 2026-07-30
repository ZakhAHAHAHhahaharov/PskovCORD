import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Me, NameEffect } from '../api'
import { useEscToClose } from '../modalStack'
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard'
import { useNameFonts } from '../hooks/useNameFonts'
import {
  NAME_EFFECTS, fontFamilyFor, nameEffectMeta, nameInitialPair, styledNameProps,
} from '../nameStyle'
import Avatar from './Avatar'
import ProfileCardHeader from './ProfileCardHeader'
import UnsavedChangesNudge from './UnsavedChangesNudge'

const PREVIEW_MESSAGE_TEXT = 'Привет! Вот так будет выглядеть мой ник в сообщениях.'

/**
 * Стиль отображаемого имени — открывается из ProfileStylesFlyout. Шрифт +
 * эффект + цвет(а), с живым предпросмотром справа (мини-карточка профиля,
 * пример сообщения, пример тайла в голосовом канале — упрощённые имитации,
 * не полноценные MessageList/VoiceStage: тем не нужны реальные данные/
 * обработчики, а нужен только тот же визуальный класс, что и в бою — см.
 * .message-author/.participant-tile-name, применяются тут же через
 * styledNameProps). Переключатель темы предпросмотра — только визуальный,
 * реальную тему приложения не трогает (см. data-theme override на обёртке).
 *
 * Черновик — локальный, одна кнопка "Сохранить" разом на все 4 поля,
 * поэтому подключён useUnsavedChangesGuard (клик мимо с несохранёнными
 * изменениями трясёт модал вместо закрытия, см. общий хук).
 */
export default function DisplayNameStyleModal({
  user,
  onSave,
  onClose,
}: {
  user: Me
  onSave: (patch: {
    name_font: number | null
    name_effect: NameEffect
    name_color_1: string
    name_color_2: string
  }) => Promise<void>
  onClose: () => void
}) {
  const fonts = useNameFonts()
  const [nameFont, setNameFont] = useState(user.name_font)
  const [nameEffect, setNameEffect] = useState(user.name_effect)
  const [color1, setColor1] = useState(user.name_color_1)
  const [color2, setColor2] = useState(user.name_color_2)
  const [previewTheme, setPreviewTheme] = useState<'dark' | 'light'>('dark')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const draft = { name_font: nameFont, name_effect: nameEffect, name_color_1: color1, name_color_2: color2 }
  const effectMeta = nameEffectMeta(nameEffect)
  const draftNameProps = styledNameProps(draft)

  const isDirty =
    nameFont !== user.name_font ||
    nameEffect !== user.name_effect ||
    color1 !== user.name_color_1 ||
    color2 !== user.name_color_2

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(draft)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const { modalRef, showNudge, handleOverlayClick } = useUnsavedChangesGuard(isDirty, onClose)
  const handleDiscard = () => {
    setNameFont(user.name_font)
    setNameEffect(user.name_effect)
    setColor1(user.name_color_1)
    setColor2(user.name_color_2)
    onClose()
  }

  useEscToClose(onClose)

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="unsaved-guard-stack">
      <div
        className="modal display-name-style-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Стиль отображаемого имени</h2>

        <div className="dns-layout">
          <div className="dns-settings">
            <div className="field-label">Шрифт</div>
            <div className="dns-font-grid">
              <button
                type="button"
                className={`dns-font-card ${nameFont === null ? 'active' : ''}`}
                onClick={() => setNameFont(null)}
              >
                <span className="dns-font-card-sample">{nameInitialPair(user)}</span>
                <span className="dns-font-card-label">Системный</span>
              </button>
              {fonts.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`dns-font-card ${nameFont === f.id ? 'active' : ''}`}
                  onClick={() => setNameFont(f.id)}
                >
                  <span
                    className="dns-font-card-sample"
                    style={{ fontFamily: fontFamilyFor(f.id) }}
                  >
                    {nameInitialPair(user)}
                  </span>
                  <span className="dns-font-card-label">{f.label}</span>
                </button>
              ))}
            </div>

            <div className="field-label">Эффект</div>
            <div className="dns-effect-grid">
              {NAME_EFFECTS.map((meta) => {
                const cardProps = styledNameProps({ ...draft, name_effect: meta.id })
                return (
                  <button
                    key={meta.id}
                    type="button"
                    className={`dns-effect-card ${nameEffect === meta.id ? 'active' : ''}`}
                    onClick={() => setNameEffect(meta.id)}
                  >
                    <span className={`dns-effect-card-preview ${cardProps.className}`} style={cardProps.style}>
                      Пример
                    </span>
                    <span className="dns-effect-card-label">{meta.label}</span>
                  </button>
                )
              })}
            </div>

            <div className="field-label">
              {effectMeta.colorCount === 2 ? 'Цвета ника' : 'Цвет ника'}
            </div>
            <div className="dns-color-row">
              <label className="gradient-color-field">
                {effectMeta.colorCount === 2 ? 'Цвет 1' : ''}
                <input type="color" value={color1 || '#5865f2'} onChange={(e) => setColor1(e.target.value)} />
              </label>
              {effectMeta.colorCount === 2 && (
                <label className="gradient-color-field">
                  Цвет 2
                  <input
                    type="color"
                    value={color2 || '#4752c4'}
                    onChange={(e) => setColor2(e.target.value)}
                  />
                </label>
              )}
              {(color1 || color2) && (
                <button
                  type="button"
                  className="styles-flyout-reset-link"
                  onClick={() => {
                    setColor1('')
                    setColor2('')
                  }}
                >
                  Сбросить цвета
                </button>
              )}
            </div>

            {error && <div className="login-error">{error}</div>}

            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 size={15} className="spin" /> : 'Сохранить'}
            </button>
            <button className="modal-close" onClick={onClose}>
              Отмена
            </button>
          </div>

          {/* data-theme здесь ВСЕГДА явный ('dark' И 'light' — оба со своими
              значениями CSS-переменных, см. .dns-preview[data-theme=...] в
              index.css), а не только для light: обычный :root[data-theme]
              каскад темы приложения матчит ТОЛЬКО настоящий <html> (см.
              комментарий у [data-theme] в index.css), вложенный div с этим
              атрибутом сам по себе ничего не переключает — нужны отдельные
              правила именно для .dns-preview, иначе "тёмная" здесь тихо
              подхватила бы РЕАЛЬНУЮ тему приложения (например oled/ash),
              если она не equals обычной тёмной. */}
          <div className="dns-preview" data-theme={previewTheme}>
            <div className="dns-preview-theme-toggle">
              <button
                type="button"
                className={previewTheme === 'dark' ? 'active' : ''}
                onClick={() => setPreviewTheme('dark')}
              >
                Тёмная
              </button>
              <button
                type="button"
                className={previewTheme === 'light' ? 'active' : ''}
                onClick={() => setPreviewTheme('light')}
              >
                Светлая
              </button>
            </div>

            <div className="dns-preview-card">
              <ProfileCardHeader
                username={user.username}
                displayName={user.display_name}
                avatarColor={user.avatar_color}
                avatarImage={user.avatar_image}
                bannerGradient={user.banner_gradient}
                bannerImage={user.banner_image}
                bannerColor={user.banner_color}
                status={user.status}
                customStatus={user.custom_status}
                customStatusEmoji={user.custom_status_emoji}
                pronouns={user.pronouns}
                nameStyle={draft}
              />
            </div>

            <div className="dns-preview-message-row">
              <Avatar name={user.username} color={user.avatar_color} image={user.avatar_image} size={36} />
              <div className="message-body">
                <div className="message-meta">
                  <span className={`message-author ${draftNameProps.className}`} style={draftNameProps.style}>
                    {user.display_name || user.username}
                  </span>
                  <span className="message-time">сегодня, 12:00</span>
                </div>
                <div className="message-content">{PREVIEW_MESSAGE_TEXT}</div>
              </div>
            </div>

            {/* Тот же ряд, что и в списке каналов слева (см. ChannelSidebar
                VoiceUserRow) — ник виден и там, в ростере голосового канала
                под его названием. */}
            <div className="dns-preview-sidebar">
              <div className="voice-user dns-preview-sidebar-row">
                <Avatar name={user.username} color={user.avatar_color} image={user.avatar_image} size={20} />
                <span className={draftNameProps.className} style={draftNameProps.style}>
                  {user.display_name || user.username}
                </span>
              </div>
            </div>

            <div className="participant-tile dns-preview-voice-tile">
              <Avatar name={user.username} color={user.avatar_color} image={user.avatar_image} size={56} />
              <span className={`participant-tile-name ${draftNameProps.className}`} style={draftNameProps.style}>
                {user.display_name || user.username}
              </span>
            </div>
          </div>
        </div>
      </div>

      {showNudge && (
        <UnsavedChangesNudge onSave={handleSave} onDiscard={handleDiscard} saving={saving} />
      )}
      </div>
    </div>
  )
}
