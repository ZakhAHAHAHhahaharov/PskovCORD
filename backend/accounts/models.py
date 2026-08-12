import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models

# Личный звук входа в голосовой канал. Играет НЕ у владельца, а у всех, кто
# уже сидит в канале, — это «мелодия выхода на сцену», а не уведомление себе.
#
# Ключи готовых вариантов совпадают с теми, что рисует и проигрывает клиент
# (см. web/src/joinSound.ts). Сами звуки, кроме 'default', синтезируются в
# браузере через Web Audio — файлов для них не нужно вовсе.
JOIN_SOUND_DEFAULT = "default"
JOIN_SOUND_NONE = "none"
JOIN_SOUND_CUSTOM = "custom"
JOIN_SOUND_PRESETS = (
    (JOIN_SOUND_DEFAULT, "Стандартный"),
    (JOIN_SOUND_NONE, "Без звука"),
    ("blip", "Короткий сигнал"),
    ("chime", "Колокольчик"),
    ("pop", "Хлопок"),
    ("rise", "Восходящий"),
    (JOIN_SOUND_CUSTOM, "Свой файл"),
)

# Свой звук — короткий. Длительность проверить нечем (ffmpeg в проекте
# сознательно нет, см. chat.uploads.sniff_sound), поэтому ограничением служит
# размер: 512 КБ это несколько секунд в любом принимаемом формате. Ровно тот
# же лимит, что у соундборда, — и по той же причине.
MAX_JOIN_SOUND_BYTES = 512 * 1024


def join_sound_upload_to(instance, filename: str) -> str:
    """MEDIA_ROOT/join_sounds/<токен>/sound.<ext>.

    Имя и расширение собираются здесь целиком, клиентское не используется —
    ровно по той же причине, что у эмодзи и соундборда: под /media/ файлы
    отдаёт nginx НАПРЯМУЮ и Content-Type выбирает по расширению. Валидный OGG
    под именем "evil.html" иначе уехал бы документом на нашем origin, где в
    localStorage лежит JWT.

    Токен, а не id пользователя, в пути: /media/ отдаётся без проверки прав,
    и угадываемый путь означал бы, что чужой звук можно скачать, просто
    подставив номер.
    """
    from chat.uploads import SOUND_EXTENSIONS

    ext = SOUND_EXTENSIONS.get(instance.join_sound_content_type, "bin")
    return f"join_sounds/{instance.join_sound_token}/sound.{ext}"


class NameFont(models.Model):
    """Шрифт для стиля отображаемого имени (см. User.name_font) — загружается
    суперпользователем через админку и становится доступен всем в пикере
    шрифтов (ProfileModal → «Стили» → «Стиль отображаемого имени»). В отличие
    от core.Favicon, тут не нужна Pillow-обработка перед сохранением — файл
    шрифта хранится как есть, поэтому обычный ModelForm/ImageField-подобный
    FileField работают без плясок с отдельной формой."""

    label = models.CharField(max_length=60, verbose_name="Название (в списке выбора)")
    file = models.FileField(upload_to="name_fonts/", verbose_name="Файл шрифта (woff2/woff/ttf)")
    uploaded_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.CASCADE,
        related_name="uploaded_name_fonts",
        verbose_name="Загрузил",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["label"]
        verbose_name = "Шрифт ника"
        verbose_name_plural = "Шрифты ника"

    def __str__(self) -> str:
        return self.label

    @property
    def family_name(self) -> str:
        # Синтетический, а не введённый вручную — гарантированно уникален и
        # не зависит от того, что admin впишет в label (два шрифта вполне
        # могут называться одинаково "для человека").
        return f"pc-namefont-{self.pk}"


class User(AbstractUser):
    """Пользователь PskovCord. Пока = стандартный Django-юзер + цвет аватара."""

    ONLINE = "online"
    DND = "dnd"
    INVISIBLE = "invisible"
    STATUS_CHOICES = [
        (ONLINE, "В сети"),
        (DND, "Не беспокоить"),
        (INVISIBLE, "Невидимка"),
    ]

    NAME_EFFECT_STANDARD = "standard"
    NAME_EFFECT_GRADIENT = "gradient"
    NAME_EFFECT_NEON = "neon"
    NAME_EFFECT_CARTOON = "cartoon"
    NAME_EFFECT_HIGHLIGHT = "highlight"
    NAME_EFFECT_CHOICES = [
        (NAME_EFFECT_STANDARD, "Минимализм"),
        (NAME_EFFECT_GRADIENT, "Градиент"),
        (NAME_EFFECT_NEON, "Неон"),
        (NAME_EFFECT_CARTOON, "Мультфильм"),
        (NAME_EFFECT_HIGHLIGHT, "Выделение"),
    ]

    avatar_color = models.CharField(max_length=7, default="#5865F2")
    # Необязательное отображаемое имя (как глобальный display name в
    # Discord) — показывается вместо username в карточке профиля, а сам
    # username под ним отдельной строкой (см. фронт ProfileModal/
    # StatusMenu/MiniProfilePopup). Пусто — используется username, второй
    # строки с ним тогда не показываем (незачем дублировать одно и то же).
    # Уникальности не требует: это просто подпись, а не идентификатор.
    display_name = models.CharField(max_length=64, blank=True, default="")
    # "О себе" в карточке профиля — свободный текст, лимит проверяется на
    # сериализаторе (см. ProfileUpdateSerializer.validate_bio), не здесь —
    # тот же приём, что у Server.description (chat.models).
    bio = models.TextField(blank=True, default="")
    # Местоимения — короткая необязательная подпись в карточке профиля,
    # рядом с username. Свободный текст (не enum/choices) — подсказки
    # стандартных вариантов (he/him, she/her, they/them...) только на
    # фронте (datalist), а не жёсткий список здесь.
    pronouns = models.CharField(max_length=24, blank=True, default="")
    # Короткий произвольный статус-текст — показывается и в нижней панели
    # пользователя (рядом со значком микрофона, если сейчас в голосовом
    # канале), и в "облачке" у аватарки в карточке профиля. Пусто —
    # в нижней панели используется обычная подпись статуса (В сети/Не
    # беспокоить/Невидимка), в карточке облачко не рисуется вовсе.
    custom_status = models.CharField(max_length=64, blank=True, default="")
    # Один эмодзи-символ перед текстом статуса (рисуется в "облачке" рядом с
    # аватаркой) — отдельное поле, а не префикс внутри custom_status: на
    # фронте это два независимых инпута (StatusEditModal), да и парсить
    # эмодзи-vs-текст из одной строки обратно было бы ненадёжно.
    custom_status_emoji = models.CharField(max_length=8, blank=True, default="")
    # data-URL (data:image/jpeg;base64,...) — хранится прямо в БД, без
    # ImageField/MEDIA_ROOT/Pillow: аватарки маленькие (сжимаются клиентом до
    # 256x256 перед отправкой), а лишний медиа-сервинг (volume + nginx
    # location, как для static/) для дружеского масштаба избыточен. Пусто —
    # аватара нет, показывается цветной кружок с буквой (avatar_color).
    avatar_image = models.TextField(blank=True, default="")
    # Анимированный аватар: data-URL гифки ЦЕЛИКОМ, как её загрузили. Пара к
    # avatar_image, а не замена ему: avatar_image в этом случае хранит один
    # выбранный кадр этой же гифки (см. avatar_frame) и остаётся тем, что
    # видно по умолчанию — гифка проигрывается только в оговорённых местах
    # (говорит в голосовом / наведение на отправителя в чате / карточка
    # профиля, см. фронт web/src/avatarAnim.ts).
    #
    # Почему отдельным полем и почему НЕ в UserSerializer: аватар едет в
    # каждом сообщении и каждой строке ростера, а гифка тяжелее статики на
    # порядки — ровно та же причина, по которой из публичного профиля в своё
    # время убрали banner_image. Отдаётся отдельной ручкой по требованию
    # (chat.views.UserAvatarAnimation), клиент её кэширует.
    avatar_anim = models.TextField(blank=True, default="")
    # Номер кадра гифки, выбранного как статичная картинка (в avatar_image).
    # Нужен только чтобы редактор открылся на том же кадре, что выбрали в
    # прошлый раз; на отрисовку не влияет.
    avatar_frame = models.PositiveIntegerField(default=0)
    # Может ли КТО-ТО ДРУГОЙ скачать аватар из карточки профиля. False —
    # кнопки скачивания не будет (см. фронт MiniProfilePopup). Это про
    # вежливость, а не про защиту: картинка всё равно приезжает в браузер,
    # и сохранить её средствами ОС никто помешать не может.
    avatar_downloadable = models.BooleanField(default=True)
    # Фон карточки профиля (всплывает над status-menu). Пусто — стандартный
    # градиент по умолчанию (см. фронт). Ровно один из двух источников
    # активен: либо CSS-градиент, либо гифка (banner_image побеждает, если
    # оба почему-то заполнены — так решает фронт при отрисовке).
    banner_gradient = models.CharField(max_length=120, blank=True, default="")
    # data-URL (data:image/gif;base64,...), как avatar_image — та же логика
    # хранения. Не транслируется другим участникам через profile_update
    # (см. accounts.views._broadcast_profile_update): пока используется
    # только в собственной карточке профиля, незачем гонять гифки по WS
    # всем на сервере.
    banner_image = models.TextField(blank=True, default="")
    # Фон ПОД баннером — виден только когда banner_image задан и это гифка/
    # картинка с прозрачностью (см. фронт ProfileCardHeader.profile-card-banner:
    # backgroundColor рисуется отдельным слоем ПОД backgroundImage). Для
    # градиента бессмысленен (тот и так непрозрачный), поэтому фронт его туда
    # не подставляет. Пусто — прозрачные пиксели гифки показывают то, что
    # рисуется под баннером в CSS по умолчанию (см. .profile-card-banner).
    banner_color = models.CharField(max_length=7, blank=True, default="")
    # Шрифт отображаемого имени в сообщениях/голосовом ростере (см.
    # NameFont выше) — null означает "системный" (обычный var(--font) на
    # фронте). SET_NULL — если админ удалит загруженный шрифт, у всех, кто
    # его выбрал, ник просто откатывается на системный, а не ломается.
    name_font = models.ForeignKey(
        "accounts.NameFont",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="Шрифт ника",
    )
    # Как обыгрывается цвет(а) ника — сам цвет(а) ниже, в name_color_1/2.
    name_effect = models.CharField(
        max_length=12, choices=NAME_EFFECT_CHOICES, default=NAME_EFFECT_STANDARD)
    # Хекс-цвета для стиля ника — сколько реально используется, зависит от
    # name_effect (см. фронт nameStyle.ts NAME_EFFECTS.colorCount): standard/
    # neon — только name_color_1, gradient/highlight — оба. Пусто — цвет не
    # переопределяется, ник рисуется обычным цветом текста темы (нулевой
    # визуальный дифф для тех, кто это не настраивал).
    name_color_1 = models.CharField(max_length=7, blank=True, default="")
    name_color_2 = models.CharField(max_length=7, blank=True, default="")
    # Множитель скорости CSS-анимации для эффектов ника, у которых она есть
    # (neon/cartoon — см. фронт nameStyle.ts/index.css, .name-style.effect-*).
    # 1.0 — обычная скорость, больше — быстрее, меньше — медленнее; диапазон
    # (0.5–2.5) зажимается на входе, см. validate_name_anim_speed. Для
    # standard/gradient/highlight поле просто не используется — CSS-переменная
    # там ни на что не влияет.
    name_anim_speed = models.FloatField(default=1.0)
    # Выбирается самим пользователем; фактическая видимость другим (online/dnd/offline)
    # вычисляется отдельно с учётом реального подключения — см. chat.presence_status.
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=ONLINE)

    # Свой набор иконок вкладки (favicon.ico/16x16/32x32/apple-touch и т.д.,
    # см. core.models.Favicon) — пусто означает "стандартная" (см.
    # core.views._resolve_favicon_id / Favicon.get_default_id). SET_NULL —
    # при удалении выбранной иконки пользователь просто откатывается на
    # стандартную, а не теряет аккаунт.
    favicon = models.ForeignKey(
        "core.Favicon",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="selected_by",
        verbose_name="Иконка вкладки",
    )

    DM_FRIENDS = "friends"
    DM_NOBODY = "nobody"
    DM_EVERYONE = "everyone"
    DM_PRIVACY_CHOICES = [
        (DM_FRIENDS, "Только друзья"),
        (DM_NOBODY, "Никто"),
        (DM_EVERYONE, "Любой зарегистрированный"),
    ]
    # Кто может НАЧАТЬ новую личку со мной (см. chat.permissions.can_dm).
    # Не влияет на уже существующие диалоги — если переписка уже началась,
    # ужесточение потом её не рвёт (проверяется только при создании).
    dm_privacy = models.CharField(
        max_length=10, choices=DM_PRIVACY_CHOICES, default=DM_EVERYONE)

    # Личный звук входа в голосовой канал — его слышат ОСТАЛЬНЫЕ, когда я
    # захожу (см. JOIN_SOUND_PRESETS выше).
    join_sound = models.CharField(
        max_length=16, choices=JOIN_SOUND_PRESETS, default=JOIN_SOUND_DEFAULT)
    # Ниже — только для join_sound == 'custom'. Файл НЕ удаляется при
    # переключении на готовый вариант: передумал и вернулся — звук на месте,
    # а заливать его заново ради этого не нужно.
    join_sound_token = models.UUIDField(default=uuid.uuid4, editable=False)
    join_sound_content_type = models.CharField(max_length=100, blank=True, default="")
    join_sound_file = models.FileField(
        upload_to=join_sound_upload_to, max_length=300, blank=True)

    def join_sound_url(self) -> str:
        """ЧТО ИГРАТЬ ОСТАЛЬНЫМ: адрес файла или пусто, если выбран готовый
        вариант. Это поле уезжает в ростер и в participants диалога.

        Пусто и тогда, когда выбран 'custom', но файла нет: так бывает у того,
        кто выбрал «свой» и не успел загрузить. Клиент в этом случае молча
        откатывается на стандартный звук (см. web/src/joinSound.ts) — тишина
        вместо звука выглядела бы поломкой.
        """
        if self.join_sound != JOIN_SOUND_CUSTOM or not self.join_sound_file:
            return ""
        return self.join_sound_file.url

    def custom_join_sound_url(self) -> str:
        """ЕСТЬ ЛИ У МЕНЯ ЗАГРУЖЕННЫЙ ФАЙЛ — независимо от текущего выбора.

        Отдельно от join_sound_url выше, потому что это разные вопросы, и
        путать их дорого: переключение на готовый вариант файл не удаляет
        (см. join_sound_file), и без этого поля собственный интерфейс решил
        бы, что файла нет, — плитка «Свой звук» стала бы недоступной, а
        кнопка «Убрать» исчезла, то есть вернуться к своему звуку было бы
        уже нельзя.

        Только в MeSerializer: это свой профиль, скрывать в нём нечего.
        """
        return self.join_sound_file.url if self.join_sound_file else ""

    def __str__(self) -> str:
        return self.username


class LoginSession(models.Model):
    """Одна строка на "сеанс" (устройство/браузер) — для «Активные сеансы» в
    настройках. Не привязана к конкретному refresh-токену напрямую: он
    ротируется на каждый /token/refresh (см. SIMPLE_JWT.ROTATE_REFRESH_TOKENS),
    а session_id — кастомный claim, который прописывается один раз при
    логине/регистрации (accounts.views.record_login_session) и переживает
    ротацию как есть (SimpleJWT при роутации переиспользует тот же объект
    токена, просто сбрасывая jti/iat/exp, — остальные claims остаются).
    jti обновляется на каждый refresh, чтобы можно было проверить, что
    сеанс всё ещё жив (см. SessionListView — сверяется с OutstandingToken)."""

    user = models.ForeignKey(
        "accounts.User", related_name="login_sessions", on_delete=models.CASCADE)
    session_id = models.UUIDField(db_index=True)
    # jti текущего (последнего выданного/обновлённого) refresh-токена этого
    # сеанса — см. rest_framework_simplejwt.token_blacklist.OutstandingToken.
    jti = models.CharField(max_length=255, db_index=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["user", "session_id"])]

    def __str__(self) -> str:
        return f"{self.user_id} @ {self.ip_address} ({self.session_id})"


class QRLoginRequest(models.Model):
    """Вход по QR-коду (как в WhatsApp/Telegram Web): страница логина на ПК
    заводит запрос и рисует QR с token'ом, телефон (уже залогиненный)
    сканирует и подтверждает — ПК получает токены поллингом.

    Цифровой код (code/candidates) — не про защиту от подбора (это сделал
    бы сам token, он длинный и случайный), а про то, чтобы человек своими
    глазами сверил ОДИН И ТОТ ЖЕ код на обоих экранах перед подтверждением —
    страховка от релея/подмены QR на фишинговой странице, тот же приём, что
    у Google Sign-in prompt."""

    PENDING = "pending"
    SCANNED = "scanned"
    CONFIRMED = "confirmed"
    DENIED = "denied"
    STATUS_CHOICES = [
        (PENDING, "Ждёт сканирования"),
        (SCANNED, "Отсканирован, ждёт подтверждения"),
        (CONFIRMED, "Подтверждён"),
        (DENIED, "Отклонён"),
    ]

    token = models.CharField(max_length=64, unique=True, db_index=True)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=PENDING)

    # Устройство, которое ПОКАЗЫВАЕТ QR (то есть то, что логинится) —
    # captured при /qr/start, показывается на телефоне при подтверждении.
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=300, blank=True, default="")

    # Кто сканирует (заполняется при /scan) — этому пользователю в итоге и
    # выдаём токены.
    user = models.ForeignKey(
        "accounts.User", null=True, blank=True,
        related_name="qr_login_requests", on_delete=models.CASCADE)

    code = models.CharField(max_length=2, blank=True, default="")
    # JSON-массив вариантов (включая верный code) — что телефон показывает
    # для выбора. Хранится, чтобы /confirm мог проверить, что выбор вообще
    # был из предложенных, а не просто угадан произвольный текст.
    candidates = models.JSONField(default=list, blank=True)

    # Токены кладутся сюда РОВНО на момент между /confirm и следующим
    # /status с ПК — тот заберёт их один раз и тут же обнулит поля (см.
    # QRStatusView.get), чтобы второй поллинг тем же token'ом ничего не
    # унёс повторно.
    access_token = models.TextField(blank=True, default="")
    refresh_token = models.TextField(blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"qr:{self.token[:8]}… ({self.status})"


class Friendship(models.Model):
    """Заявка в друзья/дружба. Одна строка на пару, направленная
    (from_user отправил to_user), но симметричная по смыслу — is_friend
    смотрит в обе стороны (см. chat.permissions.are_friends). Взаимная
    заявка (B шлёт A, пока уже висит pending A->B) не создаёт вторую
    строку, а сразу принимает существующую — см. chat.views.FriendRequests.post.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    STATUS_CHOICES = [
        (PENDING, "В ожидании"),
        (ACCEPTED, "Приняты"),
    ]

    from_user = models.ForeignKey(
        "accounts.User", related_name="sent_friend_requests",
        on_delete=models.CASCADE)
    to_user = models.ForeignKey(
        "accounts.User", related_name="received_friend_requests",
        on_delete=models.CASCADE)
    status = models.CharField(
        max_length=10, choices=STATUS_CHOICES, default=PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = ("from_user", "to_user")

    def __str__(self) -> str:
        return f"{self.from_user_id} -> {self.to_user_id} ({self.status})"
