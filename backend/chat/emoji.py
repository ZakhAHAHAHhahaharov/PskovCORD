"""Что считается допустимой реакцией.

Reaction.emoji — обычный CharField, то есть на уровне БД туда влезет любая
строка до 64 символов. Без проверки реакцией стало бы произвольное сообщение:
«ХАХАХАХА» рядом со счётчиком выглядит и работает точно так же, как эмодзи, и
превращает аккуратную ленту реакций в второй чат. Поэтому ключ реакции
проверяется здесь, в одном месте, и одинаково для каналов и личек.

Формат ключа сознательно строковый, а не «код эмодзи»: благодаря этому
кастомные эмодзи сервера (ServerEmoji) поехали в то же поле и тот же протокол,
что и unicode, — «custom:<id>», см. CUSTOM_PREFIX ниже.

Здесь же живёт и вторая половина вопроса — КОМУ такой эмодзи разрешён (can_use
/ usable_ids / sanitize_content). Она в этом же модуле, а не во вьюхах, потому
что правило одно и то же для реакции и для токена внутри текста, а мест,
откуда его спрашивают, четыре (реакции каналов и личек, отправка и правка
сообщения).
"""
import re

from .models import MAX_EMOJI_LEN, MAX_EMOJI_NAME_LEN, MIN_EMOJI_NAME_LEN

# --- кастомные эмодзи сервера -----------------------------------------------
# Ключ такой реакции выглядит как "custom:42" — то есть попадает в то же поле
# Reaction.emoji и в тот же payload, что и unicode-эмодзи, а фронт, увидев
# префикс, рисует <img> вместо символа (см. web/src/emoji.ts, parseEmojiKey —
# там симметричный разбор).
#
# normalize() проверяет только ФОРМУ ключа: существует ли такой эмодзи и
# вправе ли его ставить именно этот человек именно здесь — вопрос с контекстом
# (см. can_use ниже), а normalize вызывается и там, где контекста ещё нет.
CUSTOM_PREFIX = "custom:"
_CUSTOM_RE = re.compile(rf"^{re.escape(CUSTOM_PREFIX)}\d{{1,18}}$")

# Токен кастомного эмодзи внутри ТЕКСТА сообщения: <:имя:id> у статичного,
# <a:имя:id> у анимированного. Форма разделяемая с Discord — не ради
# совместимости, а потому что она уже решает главную задачу: id внутри токена
# делает текст самодостаточным (переименовали эмодзи — старые сообщения не
# ломаются), а буква "a" позволяет клиенту понять, нужен ли статичный кадр,
# ещё до того, как он опознает id.
EMOJI_TOKEN_RE = re.compile(
    rf"<(a?):([A-Za-z0-9_]{{{MIN_EMOJI_NAME_LEN},{MAX_EMOJI_NAME_LEN}}}):(\d{{1,18}})>")

# Допустимое имя эмодзи — тот же алфавит, что и внутри токена. Узкий он
# намеренно: имя уезжает в текст сообщения между двоеточиями, и любая
# пунктуация в нём сделала бы разбор двусмысленным.
NAME_RE = re.compile(
    rf"^[A-Za-z0-9_]{{{MIN_EMOJI_NAME_LEN},{MAX_EMOJI_NAME_LEN}}}$")

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
        # Только форма. Существование и доступность — can_use, ей нужен
        # контекст (кто и где), которого у normalize нет.
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


# --- доступность кастомного эмодзи ------------------------------------------
# Одно правило на всё: и на реакцию, и на токен внутри текста. Оно же описано
# в UI прав (см. chat/roles.py PERMISSION_FIELDS):
#
#   * эмодзи сервера, где ты состоишь, — можно всегда и везде, включая лички;
#     это то, ради чего его и загружали;
#   * эмодзи ЧУЖОГО сервера (ты в нём не состоишь) — нельзя нигде: у тебя
#     просто нет к нему доступа;
#   * внутри канала сервера X эмодзи любого ДРУГОГО сервера — только с правом
#     use_external_emoji на X. Это единственное, что ограничивает
#     использование, ровно как в Discord.
#
# Функция принимает сразу набор id, а не один: и текст сообщения, и проверка
# ленты реакций разбирают пачку, а поштучные проверки означали бы по два
# запроса в БД на каждый эмодзи в сообщении.


def usable_ids(emoji_ids, user, server=None) -> set:
    """Из переданных id — те, что этому пользователю здесь разрешены.

    server=None означает личку или групповой диалог: там нет ролей, а значит
    и нечему ограничивать — доступны все эмодзи всех твоих серверов.
    """
    from .models import Membership, ServerEmoji

    ids = {int(i) for i in emoji_ids}
    if not ids or not user or not user.is_authenticated:
        return set()

    # Один запрос на всё: сразу и существование, и «на каком сервере лежит».
    owners = dict(
        ServerEmoji.objects.filter(id__in=ids).values_list("id", "server_id"))
    if not owners:
        return set()

    my_servers = set(
        Membership.objects.filter(user=user).values_list("server_id", flat=True))
    allowed = {
        emoji_id for emoji_id, server_id in owners.items()
        if server_id in my_servers
    }
    if server is None:
        return allowed

    from . import roles

    # «Свои» эмодзи этого сервера проходят всегда — правом режется только
    # принесённое со стороны.
    external = {
        emoji_id for emoji_id in allowed if owners[emoji_id] != server.id}
    if external and not roles.permissions_for(user, server).get(
        "use_external_emoji"
    ):
        allowed -= external
    return allowed


def can_use(key: str, user, server=None) -> bool:
    """Можно ли поставить такой ключ реакции. Unicode — всегда; кастомный — по
    usable_ids. Ключ должен быть уже пропущен через normalize()."""
    if not key.startswith(CUSTOM_PREFIX):
        return True
    emoji_id = int(key[len(CUSTOM_PREFIX):])
    return emoji_id in usable_ids([emoji_id], user, server)


def sanitize_content(content: str, user, server=None) -> str:
    """Убирает из текста сообщения токены эмодзи, которых автору здесь нельзя.

    Не отклоняет сообщение целиком: «нельзя» тут — обычное дело (эмодзи удалили
    с сервера, пока висел черновик; роль сняли право на внешние), и терять
    из-за этого весь текст несоразмерно. Недоступный токен превращается в
    ":имя:" — читатель видит, что имелось в виду, но картинки не будет ни у
    кого. Именно это и есть точка контроля: без неё право «использовать внешние
    эмодзи» ничего бы не значило для текста, только для реакций.
    """
    if not content or "<" not in content:
        return content
    matches = list(EMOJI_TOKEN_RE.finditer(content))
    if not matches:
        return content
    allowed = usable_ids([m.group(3) for m in matches], user, server)
    return EMOJI_TOKEN_RE.sub(
        lambda m: m.group(0) if int(m.group(3)) in allowed else f":{m.group(2)}:",
        content,
    )
