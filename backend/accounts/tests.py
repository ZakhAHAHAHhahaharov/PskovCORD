"""Тесты профиля: смена ника/аватара (PATCH /api/auth/me) и пароля."""
import tempfile
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework.throttling import SimpleRateThrottle

from .models import MAX_JOIN_SOUND_BYTES, NameFont, QRLoginRequest

User = get_user_model()

# Валидный data-URL 1x1 PNG — достаточно, чтобы пройти validate_avatar_image
# (mime + base64-декодирование), реальное содержимое картинки не важно.
TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4"
    "2mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)

# Такой же «достаточно валидный» data-URL, но с mime гифки — для
# avatar_anim (см. ProfileUpdateSerializer.validate_avatar_anim). Содержимое
# не разбирается ни сервером, ни тестом: кадры выбирает браузер.
TINY_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"


class ProfileUpdateTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pw12345")
        self.other = User.objects.create_user(username="bob", password="pw12345")
        self.client.force_authenticate(self.user)

    def test_patch_username(self):
        resp = self.client.patch(
            "/api/auth/me", {"username": "alice2", "current_password": "pw12345"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["username"], "alice2")
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "alice2")

    def test_patch_username_conflict_case_insensitive(self):
        resp = self.client.patch(
            "/api/auth/me", {"username": "BOB", "current_password": "pw12345"})
        self.assertEqual(resp.status_code, 400)

    def test_patch_username_keeps_own_name_untouched_by_conflict_check(self):
        # Патчим на своё же (регистр другой) имя — не должно считаться занятым.
        resp = self.client.patch(
            "/api/auth/me", {"username": "Alice", "current_password": "pw12345"})
        self.assertEqual(resp.status_code, 200)

    def test_patch_username_requires_current_password(self):
        resp = self.client.patch("/api/auth/me", {"username": "alice2"})
        self.assertEqual(resp.status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "alice")

    def test_patch_username_rejects_wrong_current_password(self):
        resp = self.client.patch(
            "/api/auth/me", {"username": "alice2", "current_password": "wrongpass"})
        self.assertEqual(resp.status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "alice")

    def test_patch_current_password_not_required_without_username_change(self):
        # Аватар/баннер/приватность личных сообщений — не username, пароль
        # спрашивать незачем.
        resp = self.client.patch("/api/auth/me", {"avatar_image": TINY_PNG})
        self.assertEqual(resp.status_code, 200)

    def test_patch_avatar_image_roundtrip(self):
        resp = self.client.patch("/api/auth/me", {"avatar_image": TINY_PNG})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["avatar_image"], TINY_PNG)
        self.user.refresh_from_db()
        self.assertEqual(self.user.avatar_image, TINY_PNG)

    def test_patch_avatar_image_clear(self):
        self.user.avatar_image = TINY_PNG
        self.user.save(update_fields=["avatar_image"])
        resp = self.client.patch("/api/auth/me", {"avatar_image": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["avatar_image"], "")

    def test_patch_avatar_image_rejects_bad_mime(self):
        resp = self.client.patch(
            "/api/auth/me", {"avatar_image": "data:text/plain;base64,aGVsbG8="})
        self.assertEqual(resp.status_code, 400)

    def test_patch_avatar_image_rejects_malformed_base64(self):
        resp = self.client.patch(
            "/api/auth/me", {"avatar_image": "data:image/png;base64,not-base64!!"})
        self.assertEqual(resp.status_code, 400)

    # --- анимированный (гифка) аватар -----------------------------------
    def test_patch_avatar_anim_roundtrip(self):
        resp = self.client.patch("/api/auth/me", {
            "avatar_image": TINY_PNG,
            "avatar_anim": TINY_GIF,
            "avatar_frame": 7,
            "avatar_downloadable": False,
        })
        self.assertEqual(resp.status_code, 200)
        # Сама гифка в профиле не отдаётся — только флаг, что она есть
        # (иначе ехала бы в каждом сообщении, см. UserSerializer).
        self.assertNotIn("avatar_anim", resp.data)
        self.assertTrue(resp.data["avatar_animated"])
        self.assertEqual(resp.data["avatar_frame"], 7)
        self.assertFalse(resp.data["avatar_downloadable"])
        self.user.refresh_from_db()
        self.assertEqual(self.user.avatar_anim, TINY_GIF)

    def test_patch_avatar_anim_rejects_non_gif(self):
        resp = self.client.patch("/api/auth/me", {"avatar_anim": TINY_PNG})
        self.assertEqual(resp.status_code, 400)

    def test_patch_avatar_anim_rejects_oversized(self):
        import base64
        huge = base64.b64encode(b"x" * 5_000_000).decode()
        resp = self.client.patch(
            "/api/auth/me", {"avatar_anim": f"data:image/gif;base64,{huge}"})
        self.assertEqual(resp.status_code, 400)

    def test_new_plain_avatar_drops_previous_animation(self):
        self.user.avatar_image = TINY_PNG
        self.user.avatar_anim = TINY_GIF
        self.user.avatar_frame = 3
        self.user.save()
        resp = self.client.patch("/api/auth/me", {"avatar_image": TINY_PNG})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.data["avatar_animated"])
        self.user.refresh_from_db()
        self.assertEqual(self.user.avatar_anim, "")
        self.assertEqual(self.user.avatar_frame, 0)

    def test_removing_avatar_drops_animation(self):
        self.user.avatar_image = TINY_PNG
        self.user.avatar_anim = TINY_GIF
        self.user.save()
        resp = self.client.patch("/api/auth/me", {"avatar_image": ""})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.avatar_anim, "")

    def test_patch_avatar_image_rejects_oversized(self):
        # ~2MB декодированных данных — больше MAX_AVATAR_BYTES (1.5MB).
        import base64
        huge = base64.b64encode(b"x" * 2_000_000).decode()
        resp = self.client.patch(
            "/api/auth/me", {"avatar_image": f"data:image/png;base64,{huge}"})
        self.assertEqual(resp.status_code, 400)

    def test_avatar_color_not_writable_via_profile_update(self):
        resp = self.client.patch("/api/auth/me", {"avatar_color": "#000000"})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertNotEqual(self.user.avatar_color, "#000000")

    def test_patch_display_name_and_bio(self):
        resp = self.client.patch(
            "/api/auth/me", {"display_name": "Печенька", "bio": "Люблю чай."})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["display_name"], "Печенька")
        self.assertEqual(resp.data["bio"], "Люблю чай.")
        self.user.refresh_from_db()
        self.assertEqual(self.user.display_name, "Печенька")
        self.assertEqual(self.user.bio, "Люблю чай.")

    def test_display_name_and_bio_dont_require_password(self):
        # В отличие от username — это просто подпись/текст, не идентификатор.
        resp = self.client.patch("/api/auth/me", {"display_name": "Кто-то"})
        self.assertEqual(resp.status_code, 200)

    def test_patch_bio_rejects_too_long(self):
        resp = self.client.patch("/api/auth/me", {"bio": "x" * 301})
        self.assertEqual(resp.status_code, 400)

    def test_patch_bio_accepts_at_limit(self):
        resp = self.client.patch("/api/auth/me", {"bio": "x" * 300})
        self.assertEqual(resp.status_code, 200)

    def test_patch_pronouns_and_custom_status(self):
        resp = self.client.patch(
            "/api/auth/me",
            {"pronouns": "she/her", "custom_status": "чиню баги", "custom_status_emoji": "🐛"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["pronouns"], "she/her")
        self.assertEqual(resp.data["custom_status"], "чиню баги")
        self.assertEqual(resp.data["custom_status_emoji"], "🐛")
        self.user.refresh_from_db()
        self.assertEqual(self.user.pronouns, "she/her")
        self.assertEqual(self.user.custom_status, "чиню баги")
        self.assertEqual(self.user.custom_status_emoji, "🐛")

    def test_patch_pronouns_rejects_too_long(self):
        resp = self.client.patch("/api/auth/me", {"pronouns": "x" * 25})
        self.assertEqual(resp.status_code, 400)

    def test_patch_custom_status_rejects_too_long(self):
        resp = self.client.patch("/api/auth/me", {"custom_status": "x" * 65})
        self.assertEqual(resp.status_code, 400)

    def test_patch_custom_status_emoji_rejects_too_long(self):
        resp = self.client.patch("/api/auth/me", {"custom_status_emoji": "x" * 9})
        self.assertEqual(resp.status_code, 400)

    def test_patch_custom_status_emoji_can_clear(self):
        self.user.custom_status_emoji = "🎮"
        self.user.save(update_fields=["custom_status_emoji"])
        resp = self.client.patch("/api/auth/me", {"custom_status_emoji": ""})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.custom_status_emoji, "")

    def test_me_includes_date_joined(self):
        resp = self.client.get("/api/auth/me")
        self.assertIn("date_joined", resp.data)

    def test_unauthenticated_cannot_patch(self):
        self.client.force_authenticate(None)
        resp = self.client.patch("/api/auth/me", {"username": "hacker"})
        self.assertEqual(resp.status_code, 401)

    def test_patch_name_style_roundtrip(self):
        resp = self.client.patch(
            "/api/auth/me",
            {
                "name_effect": "gradient",
                "name_color_1": "#ff0000",
                "name_color_2": "#00ff00",
            },
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["name_effect"], "gradient")
        self.assertEqual(resp.data["name_color_1"], "#ff0000")
        self.assertEqual(resp.data["name_color_2"], "#00ff00")
        self.user.refresh_from_db()
        self.assertEqual(self.user.name_effect, "gradient")

    def test_patch_name_color_rejects_bad_hex(self):
        resp = self.client.patch("/api/auth/me", {"name_color_1": "red"})
        self.assertEqual(resp.status_code, 400)

    def test_patch_name_color_can_clear(self):
        self.user.name_color_1 = "#123456"
        self.user.save(update_fields=["name_color_1"])
        resp = self.client.patch("/api/auth/me", {"name_color_1": ""})
        self.assertEqual(resp.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.name_color_1, "")

    def test_patch_name_effect_rejects_unknown_value(self):
        resp = self.client.patch("/api/auth/me", {"name_effect": "sparkles"})
        self.assertEqual(resp.status_code, 400)

    def test_patch_banner_color_roundtrip_and_validation(self):
        resp = self.client.patch("/api/auth/me", {"banner_color": "#abcdef"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["banner_color"], "#abcdef")
        resp = self.client.patch("/api/auth/me", {"banner_color": "not-a-color"})
        self.assertEqual(resp.status_code, 400)

    # NameFont.file пишет реальные файлы на диск (MEDIA_ROOT) — override,
    # чтобы тестовые "шрифты" не оседали в backend/media/name_fonts/ на
    # реальной машине разработчика.
    @override_settings(MEDIA_ROOT=tempfile.mkdtemp())
    def test_patch_name_font_by_id(self):
        font = NameFont.objects.create(
            label="Comic",
            file=SimpleUploadedFile("comic.woff2", b"fake-font-bytes"),
            uploaded_by=self.other,
        )
        resp = self.client.patch("/api/auth/me", {"name_font": font.id})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["name_font"], font.id)
        self.user.refresh_from_db()
        self.assertEqual(self.user.name_font_id, font.id)

    @override_settings(MEDIA_ROOT=tempfile.mkdtemp())
    def test_deleting_name_font_resets_user_to_null(self):
        font = NameFont.objects.create(
            label="Comic",
            file=SimpleUploadedFile("comic.woff2", b"fake-font-bytes"),
            uploaded_by=self.other,
        )
        self.user.name_font = font
        self.user.save(update_fields=["name_font"])
        font.delete()
        self.user.refresh_from_db()
        self.assertIsNone(self.user.name_font_id)


class NameFontListTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pw12345")
        self.client.force_authenticate(self.user)

    @override_settings(MEDIA_ROOT=tempfile.mkdtemp())
    def test_list_returns_uploaded_fonts(self):
        NameFont.objects.create(
            label="Comic",
            file=SimpleUploadedFile("comic.woff2", b"fake-font-bytes"),
            uploaded_by=self.user,
        )
        resp = self.client.get("/api/auth/name-fonts")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["label"], "Comic")

    def test_unauthenticated_cannot_list(self):
        self.client.force_authenticate(None)
        resp = self.client.get("/api/auth/name-fonts")
        self.assertEqual(resp.status_code, 401)


class ChangePasswordTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="oldpass1")
        self.client.force_authenticate(self.user)

    def test_change_password_success(self):
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "oldpass1", "new_password": "newpass2",
        })
        self.assertEqual(resp.status_code, 204)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("newpass2"))
        self.assertFalse(self.user.check_password("oldpass1"))

    def test_change_password_wrong_current_rejected(self):
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "wrong", "new_password": "newpass2",
        })
        self.assertEqual(resp.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("oldpass1"))

    def test_change_password_too_short_rejected(self):
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "oldpass1", "new_password": "abc",
        })
        self.assertEqual(resp.status_code, 400)

    def test_unauthenticated_cannot_change_password(self):
        self.client.force_authenticate(None)
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "oldpass1", "new_password": "newpass2",
        })
        self.assertEqual(resp.status_code, 401)


class RegistrationAndLoginTests(APITestCase):
    """Auth-флоу целиком раньше не был покрыт ни одним тестом — при том что
    именно здесь нашлись слабая политика паролей и отсутствие отзыва токенов."""

    def test_register_returns_tokens_and_profile(self):
        resp = self.client.post("/api/auth/register", {
            "username": "newcomer", "password": "sufficientlyLong1",
        })
        self.assertEqual(resp.status_code, 201)
        self.assertIn("access", resp.data)
        self.assertIn("refresh", resp.data)
        self.assertEqual(resp.data["user"]["username"], "newcomer")

    def test_register_rejects_duplicate_username_case_insensitively(self):
        User.objects.create_user(username="taken", password="sufficientlyLong1")
        resp = self.client.post("/api/auth/register", {
            "username": "TAKEN", "password": "sufficientlyLong1",
        })
        self.assertEqual(resp.status_code, 400)

    def test_login_returns_tokens(self):
        User.objects.create_user(username="loginner", password="sufficientlyLong1")
        resp = self.client.post("/api/auth/token", {
            "username": "loginner", "password": "sufficientlyLong1",
        })
        self.assertEqual(resp.status_code, 200)
        self.assertIn("access", resp.data)
        self.assertIn("refresh", resp.data)

    def test_login_with_wrong_password_rejected(self):
        User.objects.create_user(username="loginner2", password="sufficientlyLong1")
        resp = self.client.post("/api/auth/token", {
            "username": "loginner2", "password": "totallyWrong9",
        })
        self.assertEqual(resp.status_code, 401)

    def test_refresh_rotates_and_blacklists_old_token(self):
        User.objects.create_user(username="rotator", password="sufficientlyLong1")
        login = self.client.post("/api/auth/token", {
            "username": "rotator", "password": "sufficientlyLong1",
        })
        old_refresh = login.data["refresh"]

        first = self.client.post("/api/auth/token/refresh", {"refresh": old_refresh})
        self.assertEqual(first.status_code, 200)
        self.assertIn("refresh", first.data, "ROTATE_REFRESH_TOKENS должен отдавать новый refresh")

        # Старый refresh после ротации должен быть отозван.
        second = self.client.post("/api/auth/token/refresh", {"refresh": old_refresh})
        self.assertEqual(second.status_code, 401)


class PasswordPolicyTests(APITestCase):
    """До этого единственным требованием было min_length=4 — «1234» проходил."""

    def test_short_password_rejected_on_register(self):
        resp = self.client.post("/api/auth/register", {
            "username": "shorty", "password": "1234",
        })
        self.assertEqual(resp.status_code, 400)

    def test_all_numeric_password_rejected(self):
        resp = self.client.post("/api/auth/register", {
            "username": "numeric", "password": "9182736450",
        })
        self.assertEqual(resp.status_code, 400)

    def test_common_password_rejected(self):
        resp = self.client.post("/api/auth/register", {
            "username": "common", "password": "password123",
        })
        self.assertEqual(resp.status_code, 400)

    def test_password_similar_to_username_rejected(self):
        resp = self.client.post("/api/auth/register", {
            "username": "alexanderthegreat", "password": "alexanderthegreat",
        })
        self.assertEqual(resp.status_code, 400)


class TokenRevocationTests(APITestCase):
    """Выход и смена пароля должны отзывать выданные refresh-токены."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="revoker", password="sufficientlyLong1")

    def _login(self):
        resp = self.client.post("/api/auth/token", {
            "username": "revoker", "password": "sufficientlyLong1",
        })
        return resp.data["refresh"]

    def test_logout_blacklists_refresh_token(self):
        refresh = self._login()
        self.client.force_authenticate(self.user)
        self.assertEqual(
            self.client.post("/api/auth/logout", {"refresh": refresh}).status_code, 204)
        self.client.force_authenticate(None)
        resp = self.client.post("/api/auth/token/refresh", {"refresh": refresh})
        self.assertEqual(resp.status_code, 401)

    def test_password_change_revokes_other_sessions(self):
        refresh = self._login()
        self.client.force_authenticate(self.user)
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "sufficientlyLong1",
            "new_password": "brandNewSecret7",
        })
        self.assertEqual(resp.status_code, 204)

        self.client.force_authenticate(None)
        resp = self.client.post("/api/auth/token/refresh", {"refresh": refresh})
        self.assertEqual(
            resp.status_code, 401,
            "после смены пароля старые refresh-токены обязаны перестать работать")


class AuthThrottleTests(APITestCase):
    """Троттлинга на auth-ручках не было вовсе: подбор пароля ограничивался
    только шириной канала. В обычном прогоне ставки сняты (см.
    settings.RUNNING_TESTS), поэтому здесь возвращаем их точечно."""

    def setUp(self):
        cache.clear()
        # DRF читает DEFAULT_THROTTLE_RATES в атрибут КЛАССА на импорте
        # модуля, поэтому override_settings до него не достаёт — патчим сам
        # атрибут.
        self._original_rates = SimpleRateThrottle.THROTTLE_RATES
        SimpleRateThrottle.THROTTLE_RATES = {
            "anon": None, "user": None, "auth": "3/min",
        }

    def tearDown(self):
        SimpleRateThrottle.THROTTLE_RATES = self._original_rates
        cache.clear()

    def test_login_attempts_are_rate_limited(self):
        statuses = [
            self.client.post("/api/auth/token", {
                "username": "nobody", "password": f"guess{i}Long",
            }).status_code
            for i in range(5)
        ]
        self.assertIn(429, statuses, f"ожидали 429 среди {statuses}")


class LoginSessionTests(APITestCase):
    """«Активные сеансы» в настройках — см. accounts.models.LoginSession.

    Аутентификация настоящим access-токеном (не force_authenticate): именно
    он несёт claim session_id, по которому SessionListView определяет
    is_current, — force_authenticate его бы не подставил."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="sessioner", password="sufficientlyLong1")

    def _login(self):
        resp = self.client.post("/api/auth/token", {
            "username": "sessioner", "password": "sufficientlyLong1",
        })
        return resp.data["access"], resp.data["refresh"]

    def _auth(self, access):
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")

    def test_login_creates_session_visible_in_list(self):
        access, _ = self._login()
        self._auth(access)
        resp = self.client.get("/api/auth/sessions")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertTrue(resp.data[0]["is_current"])

    def test_two_logins_show_as_two_sessions(self):
        access1, _ = self._login()
        access2, _ = self._login()
        self._auth(access2)
        resp = self.client.get("/api/auth/sessions")
        self.assertEqual(len(resp.data), 2)
        # ровно одна отмечена текущей — та, чьим токеном сейчас авторизованы.
        self.assertEqual(sum(1 for s in resp.data if s["is_current"]), 1)

    def test_refresh_keeps_single_session_row(self):
        access, refresh = self._login()
        refreshed = self.client.post("/api/auth/token/refresh", {"refresh": refresh})
        self.assertEqual(refreshed.status_code, 200)
        self._auth(refreshed.data["access"])
        resp = self.client.get("/api/auth/sessions")
        self.assertEqual(
            len(resp.data), 1,
            "ротация refresh-токена не должна плодить новую строку сеанса")
        self.assertTrue(resp.data[0]["is_current"])

    def test_logout_removes_session(self):
        access, refresh = self._login()
        self._auth(access)
        self.assertEqual(
            self.client.post("/api/auth/logout", {"refresh": refresh}).status_code, 204)
        access2, _ = self._login()
        self._auth(access2)
        resp = self.client.get("/api/auth/sessions")
        self.assertEqual(len(resp.data), 1, "должна остаться только вторая сессия")

    def test_password_change_clears_all_sessions(self):
        access, _ = self._login()
        self._login()  # второе устройство
        self._auth(access)
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "sufficientlyLong1",
            "new_password": "brandNewSecret7",
        })
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(self.user.login_sessions.count(), 0)

    def test_password_change_revokes_even_a_session_that_already_refreshed(self):
        """Регрессия: SimpleJWT заводит строку OutstandingToken только на
        самый первый токен сессии и заново — в момент блэклиста ПРЕДЫДУЩЕГО
        jti при ротации; ТЕКУЩИЙ (ещё ни разу не ротированный) jti активной
        сессии своей строки не имеет. Наивный "блэклистнуть все
        OutstandingToken пользователя" эту сессию бы не поймал — см.
        blacklist_session в revoke_all_refresh_tokens."""
        access, refresh = self._login()
        refreshed = self.client.post("/api/auth/token/refresh", {"refresh": refresh})
        rotated_refresh = refreshed.data["refresh"]

        self._auth(access)
        resp = self.client.post("/api/auth/change-password", {
            "current_password": "sufficientlyLong1",
            "new_password": "brandNewSecret7",
        })
        self.assertEqual(resp.status_code, 204)

        self.client.credentials()
        retry = self.client.post("/api/auth/token/refresh", {"refresh": rotated_refresh})
        self.assertEqual(
            retry.status_code, 401,
            "ротированный refresh-токен обязан умереть вместе со сменой пароля")

    def test_revoke_single_session(self):
        access1, _ = self._login()
        access2, refresh2 = self._login()
        self._auth(access1)
        sessions = self.client.get("/api/auth/sessions").data
        other = next(s for s in sessions if not s["is_current"])

        resp = self.client.delete(f"/api/auth/sessions/{other['id']}")
        self.assertEqual(resp.status_code, 204)

        remaining = self.client.get("/api/auth/sessions").data
        self.assertEqual(len(remaining), 1)
        self.assertTrue(remaining[0]["is_current"])

        self.client.credentials()
        retry = self.client.post("/api/auth/token/refresh", {"refresh": refresh2})
        self.assertEqual(retry.status_code, 401, "отозванный сеанс не должен обновляться")

    def test_cannot_revoke_current_session_via_detail_endpoint(self):
        access, _ = self._login()
        self._auth(access)
        own = self.client.get("/api/auth/sessions").data[0]
        resp = self.client.delete(f"/api/auth/sessions/{own['id']}")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self.user.login_sessions.count(), 1)

    def test_revoke_all_logs_out_everywhere_without_touching_password(self):
        access, refresh = self._login()
        self._login()  # второе устройство
        self._auth(access)

        resp = self.client.post("/api/auth/sessions/revoke-all")
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(self.user.login_sessions.count(), 0)

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("sufficientlyLong1"), "пароль не должен меняться")

        self.client.credentials()
        retry = self.client.post("/api/auth/token/refresh", {"refresh": refresh})
        self.assertEqual(retry.status_code, 401)


class SwitchAccountTests(APITestCase):
    """Переключение между аккаунтами, уже авторизованными на этом устройстве
    (см. web/src/accounts.ts) — см. accounts.views.SwitchAccountView."""

    def setUp(self):
        self.user_a = User.objects.create_user(
            username="switcher_a", password="sufficientlyLong1")
        self.user_b = User.objects.create_user(
            username="switcher_b", password="sufficientlyLong1")

    def _login(self, username):
        resp = self.client.post("/api/auth/token", {
            "username": username, "password": "sufficientlyLong1",
        })
        return resp.data["refresh"]

    def test_switch_to_other_known_account_issues_tokens_and_django_session(self):
        self._login("switcher_a")
        refresh_b = self._login("switcher_b")

        resp = self.client.post("/api/auth/switch", {"refresh": refresh_b})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("access", resp.data)
        self.assertIn("refresh", resp.data)
        self.assertEqual(resp.data["user"]["username"], "switcher_b")
        # Django-сессия должна указывать на B, а не на A (который логинился
        # последним обычным логином до этого switch) — см. LoginView.
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user_b.pk)

    def test_switch_bumps_target_login_session(self):
        refresh_b = self._login("switcher_b")
        before = timezone.now()
        resp = self.client.post("/api/auth/switch", {"refresh": refresh_b})
        self.assertEqual(resp.status_code, 200)
        session = self.user_b.login_sessions.get()
        self.assertGreaterEqual(session.last_seen_at, before)

    def test_switch_with_garbage_refresh_rejected_without_touching_session(self):
        self._login("switcher_a")
        resp = self.client.post("/api/auth/switch", {"refresh": "not-a-real-token"})
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user_a.pk)

    def test_switch_to_inactive_user_rejected(self):
        # Токен получаем, пока аккаунт ещё активен (иначе сам логин уже
        # откажет), деактивируем ПОСЛЕ — воспроизводит "аккаунт забанили,
        # пока refresh уже лежал сохранённым на этом устройстве".
        refresh_b = self._login("switcher_b")
        self.user_b.is_active = False
        self.user_b.save(update_fields=["is_active"])
        resp = self.client.post("/api/auth/switch", {"refresh": refresh_b})
        self.assertEqual(resp.status_code, 401)


class QRLoginTests(APITestCase):
    """Вход по QR: ПК заводит запрос (без авторизации), телефон (уже
    залогиненный) сканирует и подтверждает кодом, ПК получает токены
    поллингом. См. accounts.models.QRLoginRequest, accounts.views.QR*."""

    def setUp(self):
        self.phone_user = User.objects.create_user(
            username="qrphone", password="sufficientlyLong1")

    def _start(self):
        resp = self.client.post("/api/auth/qr/start")
        self.assertEqual(resp.status_code, 201)
        return resp.data["token"]

    def _auth_as_phone(self):
        login = self.client.post("/api/auth/token", {
            "username": "qrphone", "password": "sufficientlyLong1",
        })
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")

    def test_start_creates_pending_request_visible_by_status(self):
        token = self._start()
        resp = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["status"], "pending")
        self.assertNotIn("code", resp.data)

    def test_unknown_token_reports_expired(self):
        resp = self.client.get("/api/auth/qr/does-not-exist/status")
        self.assertEqual(resp.data["status"], "expired")

    def test_scan_requires_authentication(self):
        token = self._start()
        resp = self.client.post(f"/api/auth/qr/{token}/scan")
        self.assertEqual(resp.status_code, 401)

    def test_scan_returns_candidates_and_the_desktops_own_device_info(self):
        token = self._start()
        self._auth_as_phone()
        # Телефон и "ПК" (self.client, тот же тестовый клиент) в этом тесте
        # технически один HTTP-клиент — device в ответе обязан быть тем, что
        # /qr/start сохранил ДО авторизации (т.е. независимо от текущего
        # запроса), не текущим User-Agent'ом запроса /scan.
        resp = self.client.post(f"/api/auth/qr/{token}/scan")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["candidates"]), 4)
        self.assertIn("ip_address", resp.data["device"])
        self.assertIn("user_agent", resp.data["device"])

    def test_status_after_scan_exposes_code_from_the_same_candidates(self):
        token = self._start()
        self._auth_as_phone()
        scan = self.client.post(f"/api/auth/qr/{token}/scan")
        self.client.credentials()  # ПК не авторизован
        status = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(status.data["status"], "scanned")
        self.assertIn(status.data["code"], scan.data["candidates"])

    def test_confirm_wrong_code_denies_and_does_not_issue_tokens(self):
        token = self._start()
        self._auth_as_phone()
        scan = self.client.post(f"/api/auth/qr/{token}/scan")
        # code не приходит на телефон напрямую в scan-ответе (только
        # candidates) — берём заведомо неверный вариант, отличный от того,
        # что реально верен (сверяем через отдельный поллинг статуса).
        correct = self.client.get(f"/api/auth/qr/{token}/status")
        wrong = next(c for c in scan.data["candidates"] if c != correct.data["code"])
        resp = self.client.post(f"/api/auth/qr/{token}/confirm", {"code": wrong})
        self.assertEqual(resp.status_code, 400)

        self.client.credentials()
        first_poll = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(first_poll.data["status"], "denied")
        # denied тоже одноразовый — второй поллинг уже ничего не находит.
        second_poll = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(second_poll.data["status"], "expired")

    def test_confirm_correct_code_issues_tokens_for_the_desktop_device(self):
        token = self._start()
        self._auth_as_phone()
        self.client.post(f"/api/auth/qr/{token}/scan")
        code = self.client.get(f"/api/auth/qr/{token}/status").data["code"]

        resp = self.client.post(f"/api/auth/qr/{token}/confirm", {"code": code})
        self.assertEqual(resp.status_code, 204)

        self.client.credentials()  # снова "ПК", без авторизации
        status = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(status.data["status"], "confirmed")
        self.assertIn("access", status.data)
        self.assertEqual(status.data["user"]["username"], "qrphone")
        # ПК должен получить и Django-сессию (тот же приём, что и в обычном
        # логине/регистрации, см. LoginView) — иначе /adminpskordpro/ на этом
        # браузере молча остался бы под прежним пользователем.
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.phone_user.pk)

        # Выданный access реально работает.
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {status.data['access']}")
        me = self.client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.data["username"], "qrphone")

        # Две сессии: одна от собственного логина телефона (_auth_as_phone),
        # вторая — заведённая подтверждением QR для "ПК".
        self.assertEqual(self.phone_user.login_sessions.count(), 2)
        self.assertIsNone(QRLoginRequest.objects.first(), "запись уже должна быть удалена")

    def test_status_delivers_tokens_only_once(self):
        token = self._start()
        self._auth_as_phone()
        self.client.post(f"/api/auth/qr/{token}/scan")
        code = self.client.get(f"/api/auth/qr/{token}/status").data["code"]
        self.client.post(f"/api/auth/qr/{token}/confirm", {"code": code})

        self.client.credentials()
        first = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(first.data["status"], "confirmed")
        second = self.client.get(f"/api/auth/qr/{token}/status")
        self.assertEqual(second.data["status"], "expired")

    def test_expired_request_rejects_scan(self):
        token = self._start()
        QRLoginRequest.objects.filter(token=token).update(
            created_at=timezone.now() - timedelta(minutes=10))
        self._auth_as_phone()
        resp = self.client.post(f"/api/auth/qr/{token}/scan")
        self.assertEqual(resp.status_code, 404)

    def test_confirm_by_different_user_than_scanned_is_rejected(self):
        token = self._start()
        self._auth_as_phone()
        self.client.post(f"/api/auth/qr/{token}/scan")

        other = User.objects.create_user(username="qrother", password="sufficientlyLong1")
        other_login = self.client.post("/api/auth/token", {
            "username": "qrother", "password": "sufficientlyLong1",
        })
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {other_login.data['access']}")
        resp = self.client.post(f"/api/auth/qr/{token}/confirm", {"code": "00"})
        self.assertEqual(resp.status_code, 404)


class JoinSoundTests(APITestCase):
    """Личный звук входа: выбор готового, загрузка своего и — главное —
    что формат опознаётся по СОДЕРЖИМОМУ.

    Файлы отдаёт nginx напрямую с нашего origin, и валидный OGG под именем
    "evil.html" уехал бы документом на домене, где в localStorage лежит JWT.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="js_user", password="pw12345")
        self.other = User.objects.create_user(username="js_other", password="pw12345")
        self.client.force_authenticate(self.user)

    @staticmethod
    def _ogg(size=2048):
        return SimpleUploadedFile(
            "sound.ogg", b"OggS" + b"\x00" * (size - 4), content_type="audio/ogg")

    def test_default_is_standard_sound(self):
        resp = self.client.get("/api/auth/me")
        self.assertEqual(resp.data["join_sound"], "default")
        self.assertEqual(resp.data["join_sound_url"], "")

    def test_pick_preset(self):
        resp = self.client.put(
            "/api/auth/me/join-sound", {"join_sound": "chime"}, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["join_sound"], "chime")

    def test_unknown_preset_rejected(self):
        resp = self.client.put(
            "/api/auth/me/join-sound", {"join_sound": "сирена"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_custom_without_file_rejected(self):
        """Иначе человек выберет «свой» и услышит тишину, думая, что выбрал
        звук."""
        resp = self.client.put(
            "/api/auth/me/join-sound", {"join_sound": "custom"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_upload_switches_to_custom(self):
        resp = self.client.put(
            "/api/auth/me/join-sound", {"file": self._ogg()}, format="multipart")
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["join_sound"], "custom")
        # Путь собран сервером из опознанного типа, а не из имени файла.
        self.assertTrue(resp.data["join_sound_url"].endswith(".ogg"))
        self.assertIn("/media/join_sounds/", resp.data["join_sound_url"])

    def test_rejects_non_audio_content(self):
        bogus = SimpleUploadedFile(
            "sound.ogg", b"<html><script>alert(1)</script></html>",
            content_type="audio/ogg")
        resp = self.client.put(
            "/api/auth/me/join-sound", {"file": bogus}, format="multipart")
        self.assertEqual(resp.status_code, 400)

    def test_rejects_oversized(self):
        big = SimpleUploadedFile(
            "big.ogg", b"OggS" + b"\x00" * MAX_JOIN_SOUND_BYTES,
            content_type="audio/ogg")
        resp = self.client.put(
            "/api/auth/me/join-sound", {"file": big}, format="multipart")
        self.assertEqual(resp.status_code, 400)

    def test_switching_to_preset_keeps_uploaded_file(self):
        """Передумал и вернулся — звук на месте, заливать заново не нужно."""
        self.client.put(
            "/api/auth/me/join-sound", {"file": self._ogg()}, format="multipart")
        self.client.put(
            "/api/auth/me/join-sound", {"join_sound": "pop"}, format="json")
        self.user.refresh_from_db()
        self.assertTrue(self.user.join_sound_file)
        # Пока выбран готовый вариант, url наружу не отдаётся.
        self.assertEqual(self.user.join_sound_url(), "")

        back = self.client.put(
            "/api/auth/me/join-sound", {"join_sound": "custom"}, format="json")
        self.assertEqual(back.status_code, 200)
        self.assertTrue(back.data["join_sound_url"])

    def test_delete_returns_to_default(self):
        self.client.put(
            "/api/auth/me/join-sound", {"file": self._ogg()}, format="multipart")
        resp = self.client.delete("/api/auth/me/join-sound")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["join_sound"], "default")
        self.assertEqual(resp.data["join_sound_url"], "")

    def test_anonymous_cannot_set(self):
        self.client.force_authenticate(None)
        resp = self.client.put(
            "/api/auth/me/join-sound", {"join_sound": "pop"}, format="json")
        self.assertIn(resp.status_code, (401, 403))
