"""Тесты формы обращений и её связки с уже известными ошибками."""
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.test import RequestFactory, TestCase
from django.urls import resolve, reverse
from rest_framework.test import APIClient, APITestCase

from bugs import fingerprint
from bugs.models import ErrorGroup, ErrorKind

from .models import BugReport, ReportStatus

User = get_user_model()

REPORTS = "/api/bug-reports"
ERRORS = "/api/errors"


def form(**overrides):
    base = {
        "description": "При отправке картинки всё зависает",
        "steps": "Открыл личку, перетащил png, нажал отправить",
        "route": "/channels/3",
        "platform": "web_desktop",
        "app_version": "2026.08.01",
        "recent_errors": [],
    }
    base.update(overrides)
    return base


class BugReportCreateTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pw12345678")

    def test_report_records_username_when_logged_in(self):
        self.client.force_authenticate(self.user)
        self.client.post(REPORTS, form(), format="json")
        self.assertEqual(BugReport.objects.get().user, self.user)

    def test_anonymous_report_accepted(self):
        """Человек, у которого не выходит войти, иначе пожаловаться не может."""
        response = self.client.post(REPORTS, form(), format="json")
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(BugReport.objects.get().user)

    def test_both_fields_saved(self):
        self.client.force_authenticate(self.user)
        self.client.post(REPORTS, form(), format="json")
        report = BugReport.objects.get()
        self.assertIn("зависает", report.description)
        self.assertIn("перетащил", report.steps)

    def test_empty_description_rejected(self):
        response = self.client.post(REPORTS, form(description="   "), format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(BugReport.objects.count(), 0)

    def test_steps_are_optional(self):
        response = self.client.post(REPORTS, form(steps=""), format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(BugReport.objects.get().steps, "")

    def test_new_report_starts_as_new(self):
        self.client.post(REPORTS, form(), format="json")
        self.assertEqual(BugReport.objects.get().status, ReportStatus.NEW)

    def test_secrets_scrubbed_from_free_text(self):
        """Свободный текст — самое вероятное место, куда человек вставит
        кусок лога вместе с токеном."""
        self.client.post(
            REPORTS,
            form(description="не пускает, token=SUPERSECRETVALUE в консоли"),
            format="json",
        )
        self.assertNotIn("SUPERSECRETVALUE", BugReport.objects.get().description)

    def test_route_query_dropped(self):
        self.client.post(REPORTS, form(route="/join?invite=SECRET"), format="json")
        self.assertEqual(BugReport.objects.get().route, "/join")

    def test_unknown_platform_falls_back(self):
        self.client.post(REPORTS, form(platform="ZX-Spectrum"), format="json")
        self.assertEqual(BugReport.objects.get().platform, "unknown")

    def test_non_dict_body_rejected_without_crashing(self):
        self.assertEqual(self.client.post(REPORTS, [1, 2], format="json").status_code, 400)

    def test_response_returns_id(self):
        """В отличие от автоотчёта, эту ручку человек ждёт — ответ нужен."""
        response = self.client.post(REPORTS, form(), format="json")
        self.assertEqual(response.data["id"], BugReport.objects.get().id)

    def test_oversized_description_truncated(self):
        self.client.post(REPORTS, form(description="а" * 9000), format="json")
        self.assertLessEqual(len(BugReport.objects.get().description), 4000)


class LinkedErrorsTests(APITestCase):
    """Связка обращения с уже известными ошибками — ради неё всё и делалось."""

    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pw12345678")
        self.client.force_authenticate(self.user)
        self.error = {
            "kind": ErrorKind.JS_RUNTIME,
            "message": "Cannot read properties of undefined (reading 'attachments')",
            "stack": "at MessageInput (/assets/index-C6BpG4jH.js:44:9)",
        }

    def _report_error(self):
        self.client.post(ERRORS, {**self.error, "platform": "web_desktop"}, format="json")

    def test_report_links_to_group_of_recent_error(self):
        self._report_error()
        self.client.post(REPORTS, form(recent_errors=[self.error]), format="json")
        report = BugReport.objects.get()
        self.assertEqual(report.related_groups.count(), 1)
        self.assertEqual(report.related_groups.first(), ErrorGroup.objects.get())

    def test_link_survives_different_line_numbers(self):
        """Подпись считается тем же кодом, что и при приёме, поэтому связь не
        зависит от точного совпадения текста."""
        self._report_error()
        # Другой хеш сборки и другая позиция в строке — то, что меняется
        # после каждой выкатки.
        shifted = {**self.error, "stack": "at MessageInput (/assets/index-CFU_Kdi6.js:71:2)"}
        self.client.post(REPORTS, form(recent_errors=[shifted]), format="json")
        self.assertEqual(BugReport.objects.get().related_groups.count(), 1)

    def test_unknown_error_does_not_create_group(self):
        """Обращение не должно ЗАВОДИТЬ группу: пересланный в форму чужой
        текст плодил бы ошибки, которых ни у кого не случалось."""
        self.client.post(REPORTS, form(recent_errors=[self.error]), format="json")
        self.assertEqual(ErrorGroup.objects.count(), 0)
        self.assertEqual(BugReport.objects.get().related_groups.count(), 0)

    def test_report_without_errors_is_fine(self):
        response = self.client.post(REPORTS, form(recent_errors=[]), format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(BugReport.objects.get().related_groups.count(), 0)

    def test_garbage_recent_errors_ignored(self):
        response = self.client.post(
            REPORTS, form(recent_errors=["не объект", 42, {}]), format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(BugReport.objects.get().related_groups.count(), 0)

    def test_recent_errors_not_a_list_ignored(self):
        response = self.client.post(
            REPORTS, form(recent_errors={"kind": "js_runtime"}), format="json")
        self.assertEqual(response.status_code, 201)

    def test_only_first_ten_errors_considered(self):
        """Потолок нужен, чтобы форма не превращалась в способ заставить
        сервер посчитать сотни подписей за один запрос."""
        # Сообщения различаются СЛОВАМИ, а не числами: числа из подписи
        # вычищаются (см. fingerprint.normalize_message), поэтому «Ошибка 1»
        # и «Ошибка 2» — это одна и та же группа, и создать из них двенадцать
        # разных не вышло бы.
        words = ["альфа", "браво", "чарли", "дельта", "эхо", "фокстрот",
                 "гольф", "отель", "индия", "джульетта", "кило", "лима"]
        for word in words:
            ErrorGroup.objects.create(
                fingerprint=fingerprint.compute("js_runtime", f"Сломалось {word}", ""),
                title=f"Сломалось {word}")
        payload = [{"kind": "js_runtime", "message": f"Сломалось {word}", "stack": ""}
                   for word in words]
        self.client.post(REPORTS, form(recent_errors=payload), format="json")
        self.assertEqual(BugReport.objects.get().related_groups.count(), 10)

    def test_links_multiple_distinct_groups(self):
        self._report_error()
        other = {"kind": "websocket", "message": "WebSocket closed (1006)", "stack": ""}
        self.client.post(ERRORS, {**other, "platform": "web_desktop"}, format="json")
        self.client.post(
            REPORTS, form(recent_errors=[self.error, other]), format="json")
        self.assertEqual(BugReport.objects.get().related_groups.count(), 2)


class BugReportAdminTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(username="root", password="pw12345678")
        self.plain = User.objects.create_user(username="alice", password="pw12345678")
        self.factory = RequestFactory()

    def _changelist(self, user):
        url = reverse("admin:support_bugreport_changelist")
        request = self.factory.get(url)
        request.user = user
        return resolve(url).func(request)

    def test_staff_sees_reports_section(self):
        """Проверяем по context_data, а НЕ по отрендеренному HTML.

        Шаблон админского changelist где-то внутри копирует контекст, а это
        падает на Python 3.14 в самом Django 5.0.7 (copy(super()), см.
        подробности в bugs/tests.py). Свой шаблон сводки таким не страдает и
        там рендер проверяется целиком; здесь же render() ломался бы на
        машине разработчика, ничего не говоря о нашем коде. Список объектов
        в context_data — то же самое утверждение, только без рендера.
        """
        report = BugReport.objects.create(user=self.plain, description="не работает")
        response = self._changelist(self.admin)
        self.assertEqual(response.status_code, 200)
        changelist = response.context_data["cl"]
        self.assertEqual(list(changelist.queryset), [report])

    def test_regular_user_cannot_open_section(self):
        self.assertEqual(self._changelist(self.plain).status_code, 302)

    def test_anonymous_cannot_open_section(self):
        self.assertEqual(self._changelist(AnonymousUser()).status_code, 302)

    def test_reports_cannot_be_created_by_hand(self):
        """Обращения приходят только из формы — кнопки «добавить» быть не
        должно, иначе в списке заведутся строки без автора и контекста."""
        from django.contrib.admin.sites import site

        from .admin import BugReportAdmin

        request = self.factory.get("/")
        request.user = self.admin
        self.assertFalse(BugReportAdmin(BugReport, site).has_add_permission(request))


class ThrottleScopeTests(TestCase):
    def test_support_scope_configured(self):
        """Ручка открыта анонимам, и без своей шкалы она унаследовала бы
        общую anon-шкалу в 60/min — для формы, заполняемой руками, это на
        порядок больше нужного."""
        from django.conf import settings

        self.assertIn("support", settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"])
