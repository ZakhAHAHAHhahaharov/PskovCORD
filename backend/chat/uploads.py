"""Разбор и обеззараживание загруженных вложений.

Отдельный модуль, а не пара функций во вьюхе, потому что здесь принимается
решение о БЕЗОПАСНОСТИ, а не просто о валидации размера.

Суть проблемы: в проде nginx отдаёт /media/ напрямую с того же домена, что и
само приложение (см. deploy/nginx.conf.example), а JWT лежит в localStorage.
Файл, который браузер согласится открыть КАК ДОКУМЕНТ и выполнить в нём
скрипт — .html, .svg, .xhtml, — это stored-XSS на том же origin, то есть
кража токенов у любого, кто кликнул по вложению. Поэтому:

  1. Тип файла определяется здесь, по содержимому, а не берётся из заголовка
     запроса: клиент присылает Content-Type какой захочет.
  2. Всё, что не опознано как заведомо безопасное для встраивания, получает
     тип application/octet-stream — фронт такое не инлайнит, а только
     предлагает скачать.
  3. Вторым рубежом nginx отдаёт вложения с Content-Disposition: attachment и
     X-Content-Type-Options: nosniff — тогда даже опознанный не тем типом
     файл не выполнится как документ (на <img>/<video> это не влияет:
     Content-Disposition учитывается только при переходе, не при встраивании).

Один рубеж без другого дырявый: без (2) фронт сам вставит <img src> с svg,
без (3) любая ошибка в определении типа снова открывает XSS.
"""
import mimetypes

from PIL import Image, UnidentifiedImageError

# Растровые форматы, которые Pillow надёжно опознаёт по содержимому и которые
# не умеют исполнять скрипты. SVG здесь нет и быть не может: это XML-документ,
# который браузер выполняет со всем содержимым <script> внутри.
SAFE_IMAGE_FORMATS = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "GIF": "image/gif",
    "WEBP": "image/webp",
    "BMP": "image/bmp",
}

# Типы, которые фронт встраивает плеером. Скрипт из них не выполнить, а
# опознать по содержимому нечем (Pillow их не читает) — доверяем расширению.
# Ошибка здесь безобидна: не тот тип означает лишь «не проиграется».
EMBEDDABLE_MEDIA_PREFIXES = ("video/", "audio/")

FALLBACK_CONTENT_TYPE = "application/octet-stream"


def sniff(uploaded_file) -> tuple[str, int | None, int | None]:
    """(content_type, width, height) для загруженного файла.

    width/height не None только у картинок. Курсор файла возвращается в
    начало: после нас его читает и сохраняет FileField.
    """
    content_type, width, height = _sniff_image(uploaded_file)
    uploaded_file.seek(0)
    if content_type:
        return content_type, width, height
    return _guess_media_type(uploaded_file.name), None, None


def _sniff_image(uploaded_file) -> tuple[str | None, int | None, int | None]:
    try:
        uploaded_file.seek(0)
        with Image.open(uploaded_file) as img:
            # Pillow читает заголовок лениво, размеры доступны сразу; verify()
            # намеренно не зовём — он инвалидирует объект, а нам нужен размер.
            image_format = img.format
            width, height = img.size
    except (UnidentifiedImageError, OSError, ValueError):
        # Не картинка вовсе, либо битая — и то, и другое означает «дальше
        # разбираемся по расширению». Обвал Pillow на мусорном вводе (OSError)
        # это ожидаемый путь, а не исключительная ситуация.
        return None, None, None
    mime = SAFE_IMAGE_FORMATS.get(image_format or "")
    if not mime:
        # Формат Pillow опознал, но в белом списке его нет (ICO, TIFF, PSD…) —
        # отдаём как обычный файл, а не как встраиваемую картинку.
        return None, None, None
    return mime, width, height


# Форматы, которые годятся в кастомный эмодзи. Уже подмножество
# SAFE_IMAGE_FORMATS: JPEG и BMP отброшены не из-за безопасности, а потому что
# у эмодзи не бывает фона — без альфа-канала он станет белым квадратом.
EMOJI_IMAGE_FORMATS = {
    "PNG": "image/png",
    "GIF": "image/gif",
    "WEBP": "image/webp",
}


def sniff_emoji(uploaded_file) -> tuple[str, bool] | None:
    """(content_type, animated) для загружаемого эмодзи; None — не годится.

    Всё та же логика, что у sniff(): тип определяется по СОДЕРЖИМОМУ, а не по
    заголовку запроса. Разница в том, что здесь неопознанное не превращается в
    «файл на скачивание» — эмодзи, который нельзя нарисовать, бессмыслен,
    поэтому отказ честнее подмены типа.

    animated читаем у Pillow (is_animated есть у GIF и WEBP), а не считаем
    кадры сами: нам нужен ответ «одна картинка или несколько», а не их число.
    """
    try:
        uploaded_file.seek(0)
        with Image.open(uploaded_file) as img:
            image_format = img.format
            # У одиночного PNG атрибута нет вовсе — отсюда getattr с False.
            animated = bool(getattr(img, "is_animated", False))
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    finally:
        # FileField читает файл после нас — курсор обязан вернуться в начало
        # независимо от того, опознали мы формат или свалились на битом.
        uploaded_file.seek(0)

    mime = EMOJI_IMAGE_FORMATS.get(image_format or "")
    if not mime:
        return None
    return mime, animated


# Контейнеры, в которых браузеры отдают запись с микрофона (MediaRecorder).
# Chrome/Edge — webm с opus внутри, Firefox — ogg, Safari — mp4/m4a.
#
# Опознаются по СИГНАТУРЕ, а не по расширению, в отличие от обычных
# аудиовложений выше: у голосового расширения по-честному нет вовсе (файл
# собран в памяти браузера), а доверять присланному content_type нельзя нигде.
# Заодно это отсекает попытку выдать за голосовое что угодно другое: у
# сообщения с voice=True особая отрисовка и своё право, и пускать туда
# произвольный файл незачем.
_VOICE_SIGNATURES = (
    # EBML — общий заголовок Matroska/WebM. Отличать webm от mkv здесь, в
    # отличие от стикеров, не нужно: и то и другое браузер проиграет как
    # аудио, а видеодорожки в записи с микрофона нет.
    (b"\x1a\x45\xdf\xa3", "audio/webm"),
    (b"OggS", "audio/ogg"),
)
# У MP4/M4A сигнатура не в начале файла: первые четыре байта — размер бокса,
# и только за ними идёт "ftyp".
_MP4_BRAND_OFFSET = 4


def sniff_voice(uploaded_file) -> str | None:
    """content_type записанного голосового сообщения; None — не годится."""
    uploaded_file.seek(0)
    head = uploaded_file.read(16)
    uploaded_file.seek(0)
    for signature, mime in _VOICE_SIGNATURES:
        if head.startswith(signature):
            return mime
    if head[_MP4_BRAND_OFFSET:_MP4_BRAND_OFFSET + 4] == b"ftyp":
        return "audio/mp4"
    return None


def _guess_media_type(filename: str) -> str:
    guessed, _encoding = mimetypes.guess_type(filename or "")
    if guessed and guessed.startswith(EMBEDDABLE_MEDIA_PREFIXES):
        return guessed
    # Всё прочее — включая text/html, image/svg+xml и просто неопознанное —
    # становится «файлом на скачивание». Тип из mimetypes здесь намеренно
    # выбрасывается: он выведен из РАСШИРЕНИЯ, то есть полностью подконтролен
    # загружающему, и доверять ему для решения «встраивать ли» нельзя.
    return FALLBACK_CONTENT_TYPE
