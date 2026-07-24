"""Тесты профиля: смена ника/аватара (PATCH /api/auth/me) и пароля."""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

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
