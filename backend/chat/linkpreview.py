"""Превью ссылок: тянем og:title/description/image со страницы по ссылке.

Тянет КЛИЕНТ, а не пайплайн сообщений: увидев ссылку в тексте, он просит
GET /api/link-preview?url=… (см. chat.views.LinkPreviewView). Так сделано
нарочно —

  * бэкенд у нас один процесс daphne (см. DEPLOY.md), и лезть в чужой,
    возможно медленный, сайт прямо на пути «отправить сообщение» значит
    держать этот путь заложником чужого таймаута;
  * ничего не нужно дописывать в Message и рассылать вдогонку сообщению;
  * запросы естественным образом ограничены тем, что человек реально видит.

Результат кэшируется в БД по URL: одну и ту же ссылку в канале открывают
все, и ходить за ней на каждого читателя незачем.

БЕЗОПАСНОСТЬ. Это ручка, которая ходит по URL, присланному пользователем, —
то есть классический SSRF: без проверок ею читают http://127.0.0.1:8000,
метаданные облака (169.254.169.254) и соседей по внутренней сети, а ответ
возвращается в чат. Поэтому здесь: только http/https, резолв имени с
проверкой ВСЕХ полученных адресов на приватность, ручной обход редиректов с
той же проверкой на каждом шаге, таймаут, потолок на размер тела и разбор
только text/html.

Остаточный риск — DNS rebinding: между нашей проверкой адреса и реальным
подключением имя теоретически может перерезолвиться в приватный адрес.
Закрыть это до конца можно только подключаясь к уже проверенному IP руками,
а это ломает TLS (SNI и проверку сертификата). Для инстанса на десяток
друзей размен сознательный, а не проглядели.
"""
import ipaddress
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

# Сколько ждём чужой сервер. Он нам ничего не должен, а человек в это время
# смотрит на сообщение без карточки.
FETCH_TIMEOUT_SEC = 5

# Потолок на тело ответа. og-теги живут в <head>, то есть в первых килобайтах;
# читать ради них двадцатимегабайтную страницу (или «страницу», которая на
# самом деле бесконечный поток) незачем.
MAX_BODY_BYTES = 512 * 1024

# Редиректы обходим сами (см. модульный докстринг), поэтому и считаем сами.
MAX_REDIRECTS = 3

# Представляемся честно: часть сайтов без User-Agent отдаёт 403, а
# притворяться браузером, чтобы обойти чей-то осознанный запрет, не надо.
USER_AGENT = "PskovCordBot/1.0 (link preview)"

# Длины, за которыми текст всё равно не влезет в карточку.
MAX_TITLE_LEN = 200
MAX_DESCRIPTION_LEN = 400
MAX_URL_LEN = 2000

# Ссылка в тексте сообщения. Намеренно грубо: точный разбор URL из свободного
# текста невозможен (скобки, точка в конце предложения), а цена ошибки — не
# показанная карточка.
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


class PreviewError(Exception):
    """Превью не собрать. Текст наружу не уходит — только в лог."""


def first_url(text: str) -> str | None:
    """Первая ссылка сообщения — карточка показывается только для неё.

    Не все сразу: сообщение из десятка ссылок превратилось бы в простыню
    карточек, а заодно в десяток чужих сайтов, куда мы сходим за одно
    сообщение.
    """
    match = URL_RE.search(text or "")
    if not match:
        return None
    url = match.group(0)
    # Хвостовая пунктуация почти наверняка принадлежит предложению, а не
    # ссылке: «смотри тут: https://example.com.» — точка не часть адреса.
    url = url.rstrip(".,;:!?)]}'\"")
    return url[:MAX_URL_LEN] if url else None


def _is_public_ip(raw: str) -> bool:
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return False
    # is_global не покрывает всё, что нам мешает (и по-разному ведёт себя в
    # разных версиях Python), поэтому перечисляем явно.
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _check_host_public(host: str) -> None:
    """Все адреса, в которые резолвится имя, должны быть публичными.

    Именно ВСЕ, а не первый: имя может отдавать несколько записей, и хватит
    одной приватной, чтобы соединение ушло внутрь сети.
    """
    if not host:
        raise PreviewError("нет хоста")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise PreviewError(f"имя не резолвится: {exc}") from exc
    if not infos:
        raise PreviewError("имя не резолвится")
    for info in infos:
        if not _is_public_ip(info[4][0]):
            raise PreviewError("адрес во внутренней сети")


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise PreviewError("не http(s)")
    if not parsed.hostname:
        raise PreviewError("нет хоста")
    _check_host_public(parsed.hostname)
    return url


class _OpenGraphParser(HTMLParser):
    """Достаёт og:*/twitter:* и запасные <title>/<meta name=description>.

    Свой парсер, а не сторонняя библиотека: нужны ровно четыре поля из <head>,
    и тащить ради них зависимость в requirements не стоит.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        # <head> кончился — дальше og-тегов не бывает, и дочитывать тело
        # страницы незачем.
        self.done = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
            return
        if tag == "body":
            self.done = True
            return
        if tag != "meta":
            return
        attrs_map = {k.lower(): (v or "") for k, v in attrs}
        key = (attrs_map.get("property") or attrs_map.get("name") or "").lower()
        content = attrs_map.get("content") or ""
        if key and content and key not in self.meta:
            self.meta[key] = content

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title = data.strip()


def _fetch(url: str) -> tuple[str, str]:
    """(html, итоговый URL после редиректов). Редиректы обходим сами, потому
    что urllib следует им молча — и увёл бы нас на 127.0.0.1 мимо всех
    проверок выше."""
    current = _validate_url(url)
    for _ in range(MAX_REDIRECTS + 1):
        request = Request(
            current,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
                # Часть сайтов без этого отдаёт машинный перевод наугад.
                "Accept-Language": "ru,en;q=0.8",
            },
        )
        # urlopen сам редиректы не отдаёт наружу, поэтому запрещаем их
        # обработчику: нам нужен сырой 3xx, чтобы проверить цель.
        with _NoRedirect.opener().open(request, timeout=FETCH_TIMEOUT_SEC) as response:
            status = response.status
            if status in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    raise PreviewError("редирект без Location")
                current = _validate_url(urljoin(current, location))
                continue
            if status != 200:
                raise PreviewError(f"ответ {status}")
            content_type = (response.headers.get("Content-Type") or "").lower()
            if "html" not in content_type:
                raise PreviewError(f"не html: {content_type!r}")
            raw = response.read(MAX_BODY_BYTES)
        charset = "utf-8"
        if "charset=" in content_type:
            charset = content_type.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
        try:
            return raw.decode(charset, errors="replace"), current
        except LookupError:
            return raw.decode("utf-8", errors="replace"), current
    raise PreviewError("слишком много редиректов")


class _NoRedirect:
    """Opener, который НЕ следует редиректам сам (см. _fetch)."""

    _opener = None

    @classmethod
    def opener(cls):
        if cls._opener is None:
            from urllib.request import HTTPRedirectHandler, build_opener

            class _Stop(HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None

            cls._opener = build_opener(_Stop)
        return cls._opener


def build_preview(url: str) -> dict:
    """{"url", "title", "description", "image", "site_name"} или PreviewError."""
    html, final_url = _fetch(url)
    parser = _OpenGraphParser()
    # feed кусками, чтобы бросить разбор сразу после </head>.
    for chunk in (html[i:i + 8192] for i in range(0, len(html), 8192)):
        parser.feed(chunk)
        if parser.done:
            break
    parser.close()

    meta = parser.meta
    title = (
        meta.get("og:title")
        or meta.get("twitter:title")
        or parser.title
        or ""
    ).strip()
    description = (
        meta.get("og:description")
        or meta.get("twitter:description")
        or meta.get("description")
        or ""
    ).strip()
    image = (meta.get("og:image") or meta.get("twitter:image") or "").strip()
    site_name = (meta.get("og:site_name") or "").strip()

    if image:
        # og:image часто относительный — доводим до абсолютного и проверяем
        # так же, как саму страницу: картинку потом грузит браузер, но
        # подсовывать ему ссылку во внутреннюю сеть всё равно ни к чему.
        image = urljoin(final_url, image)
        try:
            _validate_url(image)
        except PreviewError:
            image = ""

    if not title and not description:
        raise PreviewError("нечего показывать")

    return {
        "url": final_url,
        "title": title[:MAX_TITLE_LEN],
        "description": description[:MAX_DESCRIPTION_LEN],
        "image": image[:MAX_URL_LEN],
        "site_name": site_name[:MAX_TITLE_LEN],
    }
