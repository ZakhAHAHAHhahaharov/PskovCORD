"""Приведение загруженного файла к формату стикера.

Стикер, в отличие от вложения, НЕ хранится в том виде, в каком его прислали:
он рисуется крупно, лежит в наборе рядом с сотней таких же и грузится у всех
участников сразу — то есть его вес и формат это не вкус загружающего, а общая
для всех цена. Поэтому здесь всё приводится к трём форматам и одному потолку
(chat.models.MAX_STICKER_BYTES), а не проверяется «а не слишком ли большой».

Что во что превращается:

  * любая статичная картинка (PNG, JPEG, BMP, статичный WEBP, …) → WebP,
    сторона не больше STICKER_SIDE, качество подбирается вниз, пока файл не
    влезет в лимит;
  * любая РАСТРОВАЯ анимация (GIF, анимированный WEBP, APNG) → анимированный
    WebP, тем же подбором, плюс прореживание кадров, если иначе не влезает.
    Не WebM: перекодировать в него нечем — ffmpeg на бэкенде нет, а тянуть
    его в образ ради стикеров дороже, чем оно стоит. На глаз разницы с WebM
    нет, вес сопоставим;
  * Lottie (.json и .tgs — тот же JSON под gzip) → тот же JSON, но
    пересобранный (json.loads → json.dumps): так из файла заведомо уходит
    всё, что не является Lottie, включая мусор в хвосте;
  * WebM → как есть. Это уже целевой формат для растровой анимации с альфой,
    и трогать его нечем и незачем.

Чего здесь НЕТ и быть не может: SVG. Он же вектор, но при этом XML-документ,
который браузер выполняет вместе с <script> внутри, — ровно та дыра, ради
которой существует chat.uploads (см. его докстринг). Вектор у нас Lottie,
и это JSON, который никто никогда не открывает как документ.
"""
import gzip
import json
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageSequence, UnidentifiedImageError

from .models import MAX_STICKER_BYTES, STICKER_FORMATS, STICKER_SIDE


class StickerError(Exception):
    """Файл не годится в стикеры. Текст уезжает клиенту как есть."""


@dataclass
class PreparedSticker:
    """Готовый к сохранению стикер — то, что вернёт prepare()."""
    format: str
    content_type: str
    animated: bool
    data: bytes
    # Первый кадр растровой анимации (WebP). У статичных None (первый кадр и
    # есть сам файл), у Lottie/WebM тоже None — там его рисует клиент.
    static: bytes | None


# Сигнатура контейнера Matroska/WebM — первые четыре байта EBML-заголовка.
_EBML_MAGIC = b"\x1a\x45\xdf\xa3"
# Сигнатура gzip — с неё начинается .tgs (телеграмный Lottie).
_GZIP_MAGIC = b"\x1f\x8b"

# Больше кадров в стикере не бывает осмысленно: при 24 кадрах в секунду это
# почти четыре секунды. Всё сверх — либо чьё-то видео целиком, либо гифка,
# которую всё равно придётся проредить, чтобы влезть в лимит.
MAX_FRAMES = 90

# Лестница попыток «сторона, качество, шаг по кадрам» для растровой анимации.
# Идём сверху вниз и останавливаемся на первой, что влезла в лимит: сначала
# жертвуем качеством, потом размером, и только в самом конце — плавностью,
# потому что дёрганый стикер заметен сильнее, чем мыльный.
_ANIMATED_LADDER = (
    (STICKER_SIDE, 80, 1),
    (STICKER_SIDE, 60, 1),
    (256, 55, 1),
    (256, 45, 2),
    (192, 40, 2),
    (160, 35, 3),
)

# То же самое для статичной картинки — там дешевле, поэтому шагов больше.
_STATIC_LADDER = (
    (STICKER_SIDE, 92),
    (STICKER_SIDE, 80),
    (STICKER_SIDE, 65),
    (256, 60),
    (192, 50),
)


def prepare(raw: bytes) -> PreparedSticker:
    """Разобрать присланные байты и вернуть готовый стикер.

    Порядок проверок — от самого узнаваемого к самому общему: у Lottie и WebM
    есть однозначная сигнатура, а «картинка» это всё остальное, что сумел
    открыть Pillow.
    """
    if not raw:
        raise StickerError("Файл пустой.")

    lottie = _try_lottie(raw)
    if lottie is not None:
        return lottie

    if raw.startswith(_EBML_MAGIC):
        return _prepare_webm(raw)

    return _prepare_image(raw)


# --- Lottie ------------------------------------------------------------------


def _try_lottie(raw: bytes) -> PreparedSticker | None:
    """Lottie/.tgs — либо готовый стикер, либо None (это не JSON вовсе).

    Именно None, а не исключение: «не Lottie» — нормальный путь, дальше файл
    попробуют открыть картинкой. Исключение бросается только когда JSON это
    точно JSON, но не анимация — тогда молчать нельзя, иначе человек получит
    невнятное «подойдёт только картинка» на свой .json.
    """
    payload = raw
    if raw.startswith(_GZIP_MAGIC):
        try:
            payload = gzip.decompress(raw)
        except (OSError, EOFError):
            return None
    elif raw.lstrip()[:1] != b"{":
        return None

    try:
        doc = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict):
        return None

    # Минимальный признак Lottie: слои и размер холста. Полной схемы не
    # проверяем — она огромная и меняется от версии к версии, а нам нужно
    # лишь отличить анимацию от произвольного JSON.
    if not isinstance(doc.get("layers"), list) or not doc.get("layers"):
        raise StickerError("JSON не похож на Lottie-анимацию: нет слоёв.")
    if not isinstance(doc.get("w"), (int, float)) or not isinstance(
        doc.get("h"), (int, float)
    ):
        raise StickerError("JSON не похож на Lottie-анимацию: нет размера холста.")

    # Пересобираем: из файла уходит форматирование, комментарии редакторов и
    # всё, что могло быть дописано после закрывающей скобки.
    data = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()
    if len(data) > MAX_STICKER_BYTES:
        raise StickerError(
            f"Lottie слишком большой ({len(data) // 1024} КБ, максимум "
            f"{MAX_STICKER_BYTES // 1024} КБ). Обычно помогает упростить "
            "траектории или убрать растровые изображения из анимации.")
    return PreparedSticker(
        format="lottie", content_type=STICKER_FORMATS["lottie"],
        animated=True, data=data, static=None)


# --- WebM --------------------------------------------------------------------


def _prepare_webm(raw: bytes) -> PreparedSticker:
    """WebM принимается как есть — но только убедившись, что это он.

    Matroska (.mkv) начинается ровно теми же четырьмя байтами; отличает их
    строка DocType в заголовке. Проверяем именно её, а не расширение файла:
    расширение полностью подконтрольно загружающему, а браузер играет в
    <video> только webm.
    """
    if b"webm" not in raw[:256]:
        raise StickerError("Видео должно быть в формате WebM (VP8/VP9).")
    if len(raw) > MAX_STICKER_BYTES:
        raise StickerError(
            f"WebM слишком большой ({len(raw) // 1024} КБ, максимум "
            f"{MAX_STICKER_BYTES // 1024} КБ). Помогает укоротить анимацию "
            "или уменьшить её до 320×320.")
    return PreparedSticker(
        format="webm", content_type=STICKER_FORMATS["webm"],
        animated=True, data=raw, static=None)


# --- растр -------------------------------------------------------------------


def _prepare_image(raw: bytes) -> PreparedSticker:
    try:
        with Image.open(BytesIO(raw)) as img:
            animated = bool(getattr(img, "is_animated", False))
            if animated:
                frames, durations = _read_frames(img)
            else:
                frames, durations = [_fit(img.convert("RGBA"), STICKER_SIDE)], []
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise StickerError(
            "Не удалось прочитать файл. Подойдут картинка (PNG, JPEG, WEBP, "
            "GIF), Lottie (.json/.tgs) или WebM.") from exc

    if animated:
        data = _encode_animated(frames, durations)
        static = _encode_static(frames[0])
        return PreparedSticker(
            format="webp", content_type=STICKER_FORMATS["webp"],
            animated=True, data=data, static=static)

    return PreparedSticker(
        format="webp", content_type=STICKER_FORMATS["webp"],
        animated=False, data=_encode_static(frames[0]), static=None)


def _read_frames(img) -> tuple[list, list]:
    """Кадры анимации в RGBA и их длительности в миллисекундах.

    Копия каждого кадра, а не ссылка: ImageSequence отдаёт один и тот же
    объект, перематывая его на месте, — сохранить такой список «как есть»
    значило бы получить анимацию из одного последнего кадра, повторённого N
    раз (классическая ловушка Pillow).
    """
    frames, durations = [], []
    for frame in ImageSequence.Iterator(img):
        frames.append(_fit(frame.convert("RGBA"), STICKER_SIDE))
        # 0 — «не указано»: у GIF так бывает, браузеры в этом случае берут
        # 100 мс, берём и мы, иначе анимация проигрывается мгновенно.
        durations.append(int(frame.info.get("duration") or 100) or 100)
        if len(frames) >= MAX_FRAMES:
            break
    if not frames:
        raise StickerError("В анимации не нашлось ни одного кадра.")
    return frames, durations


def _fit(image, side: int):
    """Вписать в квадрат side×side, сохранив пропорции. Ничего не дорисовываем:
    прямоугольный стикер должен остаться прямоугольным, поля ему добавит
    вёрстка."""
    if image.width <= side and image.height <= side:
        return image
    copy = image.copy()
    copy.thumbnail((side, side), Image.LANCZOS)
    return copy


def _encode_static(frame) -> bytes:
    for side, quality in _STATIC_LADDER:
        buffer = BytesIO()
        _fit(frame, side).save(buffer, format="WEBP", quality=quality, method=6)
        data = buffer.getvalue()
        if len(data) <= MAX_STICKER_BYTES:
            return data
    raise StickerError(
        f"Картинку не удалось ужать до {MAX_STICKER_BYTES // 1024} КБ. "
        "Обычно так бывает с фотографиями — стикер из рисунка с прозрачным "
        "фоном сжимается в разы лучше.")


def _encode_animated(frames: list, durations: list) -> bytes:
    for side, quality, step in _ANIMATED_LADDER:
        kept = frames[::step]
        # Прореженным кадрам достаётся суммарное время выброшенных — иначе
        # анимация не просто станет дёрганой, а ещё и ускорится в step раз.
        kept_durations = [
            sum(durations[i:i + step]) for i in range(0, len(durations), step)
        ]
        buffer = BytesIO()
        resized = [_fit(frame, side) for frame in kept]
        resized[0].save(
            buffer, format="WEBP", save_all=True, append_images=resized[1:],
            duration=kept_durations, loop=0, quality=quality, method=4,
            allow_mixed=True,
        )
        data = buffer.getvalue()
        if len(data) <= MAX_STICKER_BYTES:
            return data
    raise StickerError(
        f"Анимацию не удалось ужать до {MAX_STICKER_BYTES // 1024} КБ даже "
        "после прореживания кадров. Помогает укоротить её или уменьшить "
        "число цветов.")
