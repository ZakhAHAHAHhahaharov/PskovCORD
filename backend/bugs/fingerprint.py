"""Свёртка ошибки в её «подпись» — то, по чему одинаковые по сути ошибки
склеиваются в одну группу (см. bugs.models.ErrorGroup).

Идея заимствована у Sentry и является главной причиной, по которой здесь
вообще две модели вместо одной таблицы-лога: один сломанный компонент даёт
сотни одинаковых событий, и плоский список превращается в шум, где не видно
ни сколько людей задето, ни когда это началось.

Считается на сервере, а не на клиенте, намеренно: правила склейки придётся
подкручивать (слишком крупная группа — разделить, слишком мелкая — склеить),
и менять их на сервере можно на живой системе, а на клиенте — только с
выкаткой нового бандла, причём старые вкладки продолжат слать по-старому.
"""
import hashlib
import re

# Всё, что делает две одинаковые по сути ошибки текстово разными: конкретные
# id в сообщениях («Conversation 417 not found»), хеш бандла в путях
# (index-a3f9c1.js), позиция в строке. Без вычистки такие ошибки не склеятся
# никогда, и группировка не даст ничего.
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
_HEX = re.compile(r"\b[0-9a-f]{8,}\b", re.I)
_NUM = re.compile(r"\d+")
_QUOTED = re.compile(r"(['\"])(?:(?!\1).){0,200}\1")
_LINECOL = re.compile(r":\d+:\d+\)?$")
_URL = re.compile(r"https?://[^\s)]+")


def normalize_message(message: str) -> str:
    """Сообщение без переменной части. Кавычки схлопываются целиком: в них
    почти всегда лежит конкретное значение («Cannot read 'avatar_image'»),
    и группировать по нему — значит плодить по группе на каждое поле."""
    text = _QUOTED.sub("'?'", message)
    text = _URL.sub("<url>", text)
    text = _UUID.sub("<uuid>", text)
    text = _HEX.sub("<hex>", text)
    text = _NUM.sub("<n>", text)
    return " ".join(text.split())[:300]


def top_frame(stack: str) -> str:
    """Верхний кадр стека — место, где ошибка произошла. Именно он, а не весь
    стек: ниже по стеку лежат общие для всего приложения кадры (обработчики
    React, планировщик), и по полному стеку одинаковые ошибки из разных
    вызовов не склеятся, хотя чинить их надо в одном месте.

    Кадры самого браузера/бандлера (`node_modules`, `<anonymous>`) пропускаем —
    они не указывают на наш код."""
    for raw in stack.splitlines():
        line = raw.strip()
        if not line or not (line.startswith("at ") or "@" in line):
            continue
        if "node_modules" in line or "<anonymous>" in line:
            continue
        line = _LINECOL.sub("", line)
        line = _URL.sub("<url>", line)
        line = _HEX.sub("<hex>", line)
        return line[:200]
    return ""


def compute(kind: str, message: str, stack: str) -> str:
    """Хеш подписи. sha256 усечён до 32 символов — коллизий на таком объёме
    не будет, а короткий ключ удобнее и в индексе, и глазами в админке."""
    signature = "\n".join([kind, normalize_message(message), top_frame(stack)])
    return hashlib.sha256(signature.encode("utf-8")).hexdigest()[:32]


def title_for(message: str) -> str:
    """Заголовок группы — первая строка сообщения как есть (не нормализованная):
    в списке групп человеку нужен читаемый текст, а не «<n>» вместо чисел."""
    first = message.strip().splitlines()[0] if message.strip() else "Ошибка без сообщения"
    return first[:200]
