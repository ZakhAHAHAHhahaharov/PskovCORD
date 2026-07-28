"""Что считается допустимой реакцией.

Reaction.emoji — обычный CharField, то есть на уровне БД туда влезет любая
строка до 64 символов. Без проверки реакцией стало бы произвольное сообщение:
«ХАХАХАХА» рядом со счётчиком выглядит и работает точно так же, как эмодзи, и
превращает аккуратную ленту реакций в второй чат. Поэтому ключ реакции
проверяется здесь, в одном месте, и одинаково для каналов и личек.

Формат ключа сознательно строковый, а не «код эмодзи»: это даёт место для
кастомных эмодзи сервера потом, без миграции и без смены протокола — см.
CUSTOM_PREFIX ниже.
"""
import re

from .models import MAX_EMOJI_LEN

# --- placeholder под кастомные эмодзи сервера -------------------------------
# Задел, а не реализация: моделей ServerEmoji и загрузки картинок пока нет.
# Ключ такой реакции будет выглядеть как "custom:42" — то есть попадёт в то же
# поле Reaction.emoji и в тот же payload, что и unicode-эмодзи, а фронт,
# увидев префикс, отрисует <img> вместо символа (см. web/src/emoji.ts,
# parseEmojiKey — там симметричный разбор).
#
# Пока такие ключи ОТКЛОНЯЮТСЯ: пропускать ссылки на несуществующие эмодзи
# значило бы копить в БД реакции, которые никто не сможет отрисовать. Чтобы
# включить, останется снять этот флаг и добавить проверку существования
# ServerEmoji с таким id и доступности его отправителю.
CUSTOM_PREFIX = "custom:"
CUSTOM_EMOJI_ENABLED = False
_CUSTOM_RE = re.compile(rf"^{re.escape(CUSTOM_PREFIX)}\d{{1,18}}$")

# Диапазоны, по которым отличаем настоящий символ эмодзи от обычного текста.
# Полной таблицы Unicode здесь нет намеренно: задача — отсечь буквы и цифры,
# а не выверить каждую кодовую точку. Достаточно, чтобы в ключе встретился
# хотя бы один символ из «эмодзийных» блоков.
_EMOJI_CODEPOINT_RANGES = (
    (0x1F300, 0x1FAFF),  # пиктограммы, эмоции, символы и стрелки, доп. блоки
    (0x1F000, 0x1F2FF),  # маджонг, домино, карты, «заключённые» символы
    (0x2300, 0x23FF),    # техн. символы: часы и таймеры (⌛, ⌚, ⏰), плеер (⏩)
    (0x2600, 0x27BF),    # разное: погода, знаки зодиака, дингбаты
    (0x2B00, 0x2BFF),    # стрелки и геометрия (⭐, ⬆)
    (0x2190, 0x21FF),    # стрелки (↔ и соседи — эмодзи с VS16)
    (0x2000, 0x206F),    # пунктуация: сюда попадают ‼ и ⁉
    (0x1F1E6, 0x1F1FF),  # региональные индикаторы (флаги)
    (0xFE00, 0xFE0F),    # селекторы начертания (VS15/VS16)
    (0x200D, 0x200D),    # ZWJ — склейка составных эмодзи (👨‍👩‍👧)
)

# Символы, которые сами по себе не из «эмодзийных» блоков, но являются
# законной частью составной последовательности: клавишные кнопки вида 1️⃣ —
# это цифра + VS16 + COMBINING ENCLOSING KEYCAP.
_KEYCAP_BASE = set("0123456789#*")
_KEYCAP_MARK = 0x20E3
_ZWJ = 0x200D

# Модификаторы не являются самостоятельным эмодзи — они уточняют предыдущий.
_MODIFIER_RANGES = (
    (0xFE00, 0xFE0F),      # селекторы начертания (VS15/VS16)
    (0x1F3FB, 0x1F3FF),    # тон кожи
    (0x20E3, 0x20E3),      # COMBINING ENCLOSING KEYCAP
    (0xE0020, 0xE007F),    # tag-последовательности (флаги регионов)
)
# Флаг страны — это ДВА региональных индикатора подряд без всякого ZWJ,
# единственный законный случай двух «базовых» символов рядом.
_REGIONAL_RANGE = (0x1F1E6, 0x1F1FF)


def _is_emoji_codepoint(char: str) -> bool:
    code = ord(char)
    if code == _KEYCAP_MARK:
        return True
    return any(low <= code <= high for low, high in _EMOJI_CODEPOINT_RANGES)


def _is_modifier(code: int) -> bool:
    return any(low <= code <= high for low, high in _MODIFIER_RANGES)


def _is_regional(code: int) -> bool:
    return _REGIONAL_RANGE[0] <= code <= _REGIONAL_RANGE[1]


def _is_single_emoji(key: str) -> bool:
    """Ровно ОДИН эмодзи, а не строка из нескольких.

    Без этой проверки «🔥», повторённый сорок раз, был бы совершенно законным
    ключом реакции: он проходит и по длине (одна кодовая точка на символ), и
    по «есть хотя бы один эмодзийный символ». То есть лента реакций всё равно
    заполнялась бы произвольными строками, просто из эмодзи.

    Правило: самостоятельные (не модификаторы) символы могут идти подряд
    только будучи склеенными ZWJ — так устроены составные эмодзи вроде
    👨‍👩‍👧. Отдельно разбираются флаги: там два региональных индикатора
    рядом без всякого ZWJ.
    """
    codes = [ord(char) for char in key]
    regional = [code for code in codes if _is_regional(code)]
    if regional:
        # Флаг: только региональные индикаторы, ровно два.
        return len(regional) == len(codes) and len(codes) == 2

    bases = 0
    joined = False
    for code in codes:
        if code == _ZWJ:
            joined = True
            continue
        if _is_modifier(code):
            continue
        if bases and not joined:
            # Два самостоятельных эмодзи рядом — это уже строка, а не реакция.
            return False
        bases += 1
        joined = False
    # Сюда доходят либо одиночный эмодзи, либо составной, где все базовые
    # символы склеены ZWJ (цикл выше отверг бы любое другое сочетание).
    return bases >= 1


def normalize(raw) -> str | None:
    """Приводит присланный клиентом ключ реакции к каноничному виду.

    Возвращает None, если реакцией это быть не может — вызывающий (консьюмер)
    в таком случае просто ничего не делает, как и с любой другой негодной
    операцией: молча, без ответа об ошибке.
    """
    if not isinstance(raw, str):
        return None
    key = raw.strip()
    if not key or len(key) > MAX_EMOJI_LEN:
        return None

    if key.startswith(CUSTOM_PREFIX):
        if not CUSTOM_EMOJI_ENABLED:
            return None
        return key if _CUSTOM_RE.match(key) else None

    # Внутри ключа пробелов быть не может: это ровно один эмодзи, а не фраза.
    if any(char.isspace() for char in key):
        return None
    # Буквы и цифры сами по себе — не реакция. Цифра допустима только как
    # основа клавишной кнопки (1️⃣), то есть в связке с _KEYCAP_MARK.
    if any(char.isalpha() for char in key):
        return None
    if not any(_is_emoji_codepoint(char) for char in key):
        return None
    if any(char in _KEYCAP_BASE for char in key) and not any(
        ord(char) == _KEYCAP_MARK for char in key
    ):
        return None
    if not _is_single_emoji(key):
        return None
    return key
