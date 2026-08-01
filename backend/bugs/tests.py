"""Тесты приёма отчётов об ошибках, группировки и сводки в админке."""
from datetime import timedelta
from io import StringIO

from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.core.management import call_command
from django.test import RequestFactory, TestCase
from django.urls import resolve, reverse
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from . import fingerprint, scrub
from .models import ErrorEvent, ErrorGroup, ErrorKind, GroupStatus, Platform
from .views import summary_stats

User = get_user_model()

INGEST = "/api/errors"


def payload(**overrides):
    base = {
        "kind": ErrorKind.JS_RUNTIME,
        "message": "TypeError: Cannot read properties of undefined",
        "stack": "at HomeSidebar (/assets/index-a1b2c3d4.js:120:15)",
        "route": "/channels/7",
        "platform": Platform.WEB_DESKTOP,
        "app_version": "2026.08.01",
    }
    base.update(overrides)
    return base


class FingerprintTests(TestCase):
    def test_same_error_different_ids_groups_together(self):
        """Числа и значения в кавычках — переменная часть; из-за них
        одинаковые по сути ошибки не склеились бы никогда."""
        a = fingerprint.compute(
            "js_runtime", "Conversation 417 not found",
            "at load (/assets/index-a1b2.js:10:5)")
        b = fingerprint.compute(
            "js_runtime", "Conversation 982 not found",
            "at load (/assets/index-a1b2.js:64:9)")
        self.assertEqual(a, b)

    def test_different_errors_stay_apart(self):
        a = fingerprint.compute("js_runtime", "Cannot read x", "at A (/f.js:1:1)")
        b = fingerprint.compute("js_runtime", "Network request failed", "at B (/g.js:1:1)")
        self.assertNotEqual(a, b)

    def test_same_message_different_kind_stays_apart(self):
        """Тип — часть подписи: одинаковый текст из голоса и из рендера
        чинится в разных местах."""
        a = fingerprint.compute("voice_webrtc", "Timeout", "at X (/f.js:1:1)")
        b = fingerprint.compute("websocket", "Timeout", "at X (/f.js:1:1)")
        self.assertNotEqual(a, b)

    def test_bundle_hash_ignored(self):
        """После новой сборки хеш в имени файла другой — группа должна
        остаться прежней, иначе каждая выкатка обнуляла бы статистику.

        Хеши здесь — НАСТОЯЩИЕ, из реальной сборки этого проекта. Раньше в
        тесте стояли выдуманные `index-aaaa1111.js`, они оказались
        шестнадцатеричными, тест проходил — а Vite клеит base64url
        (`index-C6BpG4jH.js`), и на нём всё разваливалось.
        """
        a = fingerprint.compute("js_runtime", "Boom", "at f (/assets/index-C6BpG4jH.js:5:1)")
        b = fingerprint.compute("js_runtime", "Boom", "at f (/assets/index-CFU_Kdi6.js:5:1)")
        self.assertEqual(a, b)

    def test_bundle_hash_ignored_in_absolute_url(self):
        """В проде фреймы приезжают с полным URL, в деве — с относительным
        путём; хеш должен вычищаться в обоих случаях."""
        a = fingerprint.compute(
            "js_runtime", "Boom", "at f (https://pskord.zlgvpn.org/assets/app-B6ZICevU.js:5:1)")
        b = fingerprint.compute(
            "js_runtime", "Boom", "at f (https://pskord.zlgvpn.org/assets/app-DTcAKEUL.js:9:4)")
        self.assertEqual(a, b)

    def test_different_files_still_stay_apart(self):
        """Вычистка хеша не должна склеивать РАЗНЫЕ файлы — иначе ошибки из
        несвязанных модулей попадали бы в одну группу."""
        a = fingerprint.compute("js_runtime", "Boom", "at f (/assets/index-C6BpG4jH.js:5:1)")
        b = fingerprint.compute("js_runtime", "Boom", "at f (/assets/vendor-C6BpG4jH.js:5:1)")
        self.assertNotEqual(a, b)

    def test_hyphenated_source_names_not_mistaken_for_hashes(self):
        """Имя файла из строчных букв длиной 8+ под правило вычистки хеша
        подходило бы по одной длине — и два несвязанных модуля склеились бы
        в одну группу. Спасает требование смешанного регистра."""
        a = fingerprint.compute("js_runtime", "Boom", "at f (/src/bug-reporting.js:5:1)")
        b = fingerprint.compute("js_runtime", "Boom", "at f (/src/bug-conversation.js:5:1)")
        self.assertNotEqual(a, b)

    def test_top_frame_skips_vendor_frames(self):
        stack = (
            "at Object.react_stack (/assets/node_modules/react-dom.js:9:1)\n"
            "at MessageList (/assets/index-a1.js:44:2)"
        )
        self.assertIn("MessageList", fingerprint.top_frame(stack))


class ScrubTests(TestCase):
    def test_jwt_removed(self):
        text = "401 for eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.abcdefghijk"
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", scrub.scrub(text))

    def test_email_removed(self):
        self.assertNotIn("cool.djesus@gmail.com", scrub.scrub("mail cool.djesus@gmail.com failed"))

    def test_named_secret_param_removed(self):
        cleaned = scrub.scrub("failed with token=abc123 and code=7788")
        self.assertNotIn("abc123", cleaned)
        self.assertNotIn("7788", cleaned)

    def test_route_query_dropped_entirely(self):
        """В query у SPA приезжают коды приглашений и токены QR-входа —
        проще потерять весь хвост, чем гадать, какой параметр безопасен."""
        self.assertEqual(scrub.scrub_route("/join?invite=SECRET123&x=1"), "/join")

    def test_data_url_truncated(self):
        long_data = "data:image/png;base64," + "A" * 5000
        self.assertLess(len(scrub.scrub(f"broke on {long_data}")), 200)

    def test_empty_is_safe(self):
        self.assertEqual(scrub.scrub(""), "")
        self.assertEqual(scrub.scrub_route(""), "")


class ErrorIngestTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pw12345678")

    def test_anonymous_report_accepted(self):
        """Ошибки экрана входа ловятся только так — до появления пользователя."""
        response = self.client.post(INGEST, payload(), format="json")
        self.assertEqual(response.status_code, 204)
        event = ErrorEvent.objects.get()
        self.assertIsNone(event.user)

    def test_authenticated_report_records_username(self):
        self.client.force_authenticate(self.user)
        self.client.post(INGEST, payload(), format="json")
        self.assertEqual(ErrorEvent.objects.get().user, self.user)

    def test_repeat_increments_group_not_creates_new(self):
        for _ in range(3):
            self.client.post(INGEST, payload(), format="json")
        self.assertEqual(ErrorGroup.objects.count(), 1)
        self.assertEqual(ErrorEvent.objects.count(), 3)
        self.assertEqual(ErrorGroup.objects.get().times_seen, 3)

    def test_first_report_sets_times_seen_to_one(self):
        self.client.post(INGEST, payload(), format="json")
        self.assertEqual(ErrorGroup.objects.get().times_seen, 1)

    def test_distinct_errors_create_distinct_groups(self):
        self.client.post(INGEST, payload(), format="json")
        self.client.post(INGEST, payload(message="Network request failed"), format="json")
        self.assertEqual(ErrorGroup.objects.count(), 2)

    def test_empty_message_rejected(self):
        response = self.client.post(INGEST, payload(message="   "), format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(ErrorGroup.objects.count(), 0)

    def test_unknown_kind_and_platform_fall_back(self):
        """Клиент может быть старее сервера (или наоборот) — незнакомое
        значение не должно ронять приём."""
        self.client.post(
            INGEST, payload(kind="сомнительно", platform="ZX-Spectrum"), format="json")
        self.assertEqual(ErrorGroup.objects.get().kind, ErrorKind.JS_RUNTIME)
        self.assertEqual(ErrorEvent.objects.get().platform, Platform.UNKNOWN)

    def test_secrets_scrubbed_before_saving(self):
        self.client.post(
            INGEST,
            payload(message="401 token=SUPERSECRETVALUE", route="/join?invite=XYZ"),
            format="json",
        )
        event = ErrorEvent.objects.get()
        self.assertNotIn("SUPERSECRETVALUE", event.message)
        self.assertNotIn("XYZ", event.route)

    def test_oversized_stack_truncated(self):
        self.client.post(INGEST, payload(stack="at f (/a.js:1:1)\n" * 5000), format="json")
        self.assertLessEqual(len(ErrorEvent.objects.get().stack), 8000)

    def test_broken_token_still_accepted_as_anonymous(self):
        """Главный смысл OptionalJWTAuthentication: сессия развалилась,
        приложение сыплет ошибками — и они всё равно доезжают."""
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION="Bearer это.не.токен")
        response = client.post(INGEST, payload(), format="json")
        self.assertEqual(response.status_code, 204)
        self.assertIsNone(ErrorEvent.objects.get().user)

    def test_valid_token_still_identifies_user(self):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(self.user)}")
        client.post(INGEST, payload(), format="json")
        self.assertEqual(ErrorEvent.objects.get().user, self.user)

    def test_user_agent_recorded_from_header(self):
        self.client.post(
            INGEST, payload(), format="json", HTTP_USER_AGENT="Mozilla/5.0 (Test)")
        self.assertIn("Mozilla", ErrorEvent.objects.get().user_agent)

    def test_non_dict_body_rejected_without_crashing(self):
        response = self.client.post(INGEST, [1, 2, 3], format="json")
        self.assertEqual(response.status_code, 400)


class RegressionTests(TestCase):
    def setUp(self):
        self.group = ErrorGroup.objects.create(
            fingerprint="f" * 32, title="Boom", kind=ErrorKind.JS_RUNTIME)

    def test_group_resolved_then_seen_again_is_regressed(self):
        self.group.status = GroupStatus.RESOLVED
        self.group.resolved_at = timezone.now() - timedelta(days=1)
        self.group.save()
        self.group.refresh_from_db()
        self.assertTrue(self.group.is_regressed)

    def test_resolved_and_quiet_is_not_regressed(self):
        self.group.status = GroupStatus.RESOLVED
        self.group.resolved_at = timezone.now() + timedelta(days=1)
        self.group.save()
        self.assertFalse(self.group.is_regressed)

    def test_open_group_is_never_regressed(self):
        self.assertFalse(self.group.is_regressed)


class SummaryStatsTests(APITestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username="alice", password="pw12345678")
        self.bob = User.objects.create_user(username="bob", password="pw12345678")

    def test_counts_distinct_people_not_events(self):
        """Ключевая метрика сводки: одна ошибка в цикле у одного человека —
        это не то же самое, что та же ошибка у двоих."""
        self.client.force_authenticate(self.alice)
        for _ in range(5):
            self.client.post(INGEST, payload(), format="json")
        self.client.force_authenticate(self.bob)
        self.client.post(INGEST, payload(), format="json")

        stats = summary_stats(14)
        self.assertEqual(stats["total_events"], 6)
        self.assertEqual(stats["affected_users"], 2)
        self.assertEqual(stats["top_groups"][0].affected, 2)

    def test_ignores_events_outside_window(self):
        self.client.force_authenticate(self.alice)
        self.client.post(INGEST, payload(), format="json")
        ErrorEvent.objects.update(created_at=timezone.now() - timedelta(days=40))
        self.assertEqual(summary_stats(14)["total_events"], 0)
        self.assertEqual(summary_stats(90)["total_events"], 1)

    def test_empty_database_does_not_crash(self):
        stats = summary_stats(14)
        self.assertEqual(stats["total_events"], 0)
        self.assertEqual(stats["by_day"], [])


class DashboardViewTests(TestCase):
    """Сводка вызывается через RequestFactory, а не через self.client,
    намеренно.

    Тест-клиент на каждый отрендеренный шаблон копирует контекст, а это
    на Python 3.14 падает внутри самого Django 5.0.7
    (BaseContext.__copy__ делает copy(super()), поведение которого
    изменилось) — то есть тесты ломались бы на машине разработчика, ничего
    не говоря о нашем коде. Через RequestFactory рендер идёт тем же путём,
    но без этой инструментовки, и проверка одинаково честна и на 3.12 в CI,
    и на 3.14 локально.

    Вьюху берём из резолвера, а не напрямую из ErrorGroupAdmin: так в
    проверку попадает и обёртка admin_view (права), и то, что маршрут вообще
    доехал до нужной функции.
    """

    def setUp(self):
        self.admin = User.objects.create_superuser(
            username="root", password="pw12345678")
        self.plain = User.objects.create_user(username="alice", password="pw12345678")
        self.url = reverse("admin:bugs_errorgroup_dashboard")
        self.factory = RequestFactory()

    def _get(self, user, **params):
        request = self.factory.get(self.url, params)
        request.user = user
        return resolve(self.url).func(request)

    def test_staff_sees_dashboard(self):
        self.assertEqual(self._get(self.admin).status_code, 200)

    def test_regular_user_redirected_to_login(self):
        self.assertEqual(self._get(self.plain).status_code, 302)

    def test_anonymous_redirected_to_login(self):
        self.assertEqual(self._get(AnonymousUser()).status_code, 302)

    def test_dashboard_renders_with_data(self):
        group = ErrorGroup.objects.create(
            fingerprint="a" * 32, title="Cannot read 'avatar'", kind=ErrorKind.RENDER)
        ErrorEvent.objects.create(
            group=group, user=self.plain, platform=Platform.WEB_MOBILE,
            message="Cannot read 'avatar'")
        html = self._get(self.admin).render().content.decode()
        self.assertIn("Cannot read", html)
        self.assertIn("bugs-charts-data", html)

    def test_apostrophe_in_title_does_not_break_chart_json(self):
        """Заголовки ошибок сплошь с апострофами («Cannot read 'x'») — ручной
        json.dumps в <script> на них и ломался, поэтому данные едут через
        json_script."""
        group = ErrorGroup.objects.create(
            fingerprint="c" * 32, title="Cannot read 'avatar' of </script>")
        ErrorEvent.objects.create(group=group, user=self.plain, message="x")
        html = self._get(self.admin).render().content.decode()
        self.assertNotIn("of </script>", html)

    def test_days_parameter_is_clamped(self):
        """?days=99999 не должен превращаться в запрос за всю историю."""
        self.assertEqual(self._get(self.admin, days="99999").context_data["stats"]["days"], 90)

    def test_garbage_days_parameter_falls_back(self):
        self.assertEqual(
            self._get(self.admin, days="сколько-нибудь").context_data["stats"]["days"], 14)

    def test_dashboard_route_not_swallowed_by_object_id(self):
        """У ModelAdmin последним маршрутом идёт catch-all <path:object_id>/,
        и «dashboard» уехал бы в него как id объекта, если бы свои маршруты
        не шли ПЕРЕД стандартными."""
        self.assertEqual(
            resolve(self.url).view_name, "admin:bugs_errorgroup_dashboard")


class PruneCommandTests(TestCase):
    def setUp(self):
        self.group = ErrorGroup.objects.create(
            fingerprint="b" * 32, title="Old", times_seen=5)

    def _event(self, age_days):
        event = ErrorEvent.objects.create(group=self.group, message="x")
        ErrorEvent.objects.filter(pk=event.pk).update(
            created_at=timezone.now() - timedelta(days=age_days))
        return event

    def test_old_events_removed_and_fresh_kept(self):
        self._event(200)
        self._event(1)
        call_command("prune_error_events", "--days", "90", stdout=StringIO())
        self.assertEqual(ErrorEvent.objects.count(), 1)

    def test_group_survives_pruning(self):
        """История группы (когда впервые, сколько всего) — это и есть длинная
        картина, ради которой группировка заведена."""
        self._event(200)
        call_command("prune_error_events", "--days", "90", stdout=StringIO())
        self.group.refresh_from_db()
        self.assertEqual(self.group.times_seen, 5)

    def test_empty_closed_groups_dropped_only_when_asked(self):
        self._event(200)
        self.group.status = GroupStatus.RESOLVED
        self.group.save()
        call_command("prune_error_events", "--days", "90", stdout=StringIO())
        self.assertEqual(ErrorGroup.objects.count(), 1)
        call_command(
            "prune_error_events", "--days", "90", "--drop-empty-groups",
            stdout=StringIO())
        self.assertEqual(ErrorGroup.objects.count(), 0)

    def test_open_group_never_dropped(self):
        """Открытая ошибка без свежих событий — всё ещё открытая ошибка."""
        self._event(200)
        call_command(
            "prune_error_events", "--days", "90", "--drop-empty-groups",
            stdout=StringIO())
        self.assertEqual(ErrorGroup.objects.count(), 1)
