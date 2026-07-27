"""Тесты профиля: смена ника/аватара (PATCH /api/auth/me) и пароля."""
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase
from rest_framework.throttling import SimpleRateThrottle

User = get_user_model()

# Валидный data-URL 1x1 PNG — достаточно, чтобы пройти validate_avatar_image
# (mime + base64-декодирование), реальное содержимое картинки не важно.
TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4"
    "2mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


class ProfileUpdateTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pw12345")
        self.other = User.objects.create_user(username="bob", password="pw12345")
        self.client.force_authenticate(self.user)

    def test_patch_username(self):
        resp = self.client.patch("/api/auth/me", {"username": "alice2"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["username"], "alice2")
        self.user.refresh_from_db()
        self.assertEqual(self.user.username, "alice2")

    def test_patch_username_conflict_case_insensitive(self):
        resp = self.client.patch("/api/auth/me", {"username": "BOB"})
        self.assertEqual(resp.status_code, 400)

    def test_patch_username_keeps_own_name_untouched_by_conflict_check(self):
        # Патчим на своё же (регистр другой) имя — не должно считаться занятым.
        resp = self.client.patch("/api/auth/me", {"username": "Alice"})
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

    def test_unauthenticated_cannot_patch(self):
        self.client.force_authenticate(None)
        resp = self.client.patch("/api/auth/me", {"username": "hacker"})
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
