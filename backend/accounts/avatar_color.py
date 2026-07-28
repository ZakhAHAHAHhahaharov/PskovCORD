import base64
import binascii
import io

from PIL import Image, UnidentifiedImageError

# Сторона, до которой уменьшаем картинку перед подсчётом среднего — тайл
# аватара и так максимум 256x256 (см. web/src/images.ts AVATAR_SIZE), гонять
# полное разрешение ради одного среднего цвета незачем.
_SAMPLE_SIZE = 32


def compute_avatar_color(data_url):
    """Средний цвет картинки-аватара (data-URL) в виде "#rrggbb".

    Используется как avatar_color — раньше это был только фон буквы-
    заглушки, когда своей картинки нет (см. accounts.models.User.avatar_color),
    теперь ещё и акцент тайла участника в голосовом канале, когда картинка
    ЕСТЬ (см. web/src/components/VoiceStage.tsx .participant-tile). Вызывается
    и из ProfileUpdateSerializer при каждой смене аватара, и из миграции
    0009 (бэкафилл для аватаров, загруженных до появления этой фичи).

    None, если data_url пустой или не разобрался как картинка — вызывающий
    код в этом случае просто не трогает существующий avatar_color.
    """
    if not data_url or not data_url.startswith("data:"):
        return None
    _, _, b64data = data_url.partition(",")
    try:
        raw = base64.b64decode(b64data, validate=True)
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGB")
        img = img.resize((_SAMPLE_SIZE, _SAMPLE_SIZE))
    except (binascii.Error, ValueError, UnidentifiedImageError, OSError):
        return None
    pixels = list(img.getdata())
    if not pixels:
        return None
    r = sum(p[0] for p in pixels) // len(pixels)
    g = sum(p[1] for p in pixels) // len(pixels)
    b = sum(p[2] for p in pixels) // len(pixels)
    return "#{:02x}{:02x}{:02x}".format(r, g, b)
