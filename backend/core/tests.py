import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase


class SpaViewTests(TestCase):
    """core.views.spa — раздача собранного веб-клиента.

    web/dist здесь ФЕЙКОВЫЙ (tempfile), а не настоящая сборка — реальный
    web/ не смонтирован в тестовое окружение бэкенда (см. известные
    падения EmojiKeyTests из-за отсутствия /web/src/emoji.ts). Достаточно
    минимального index.html + одного файла в assets/, чтобы проверить
    именно логику раздачи (кэш-заголовки, честный 404 на отсутствующий
    ассет), а не саму сборку.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        dist = Path(self.tmp.name)
        (dist / "assets").mkdir()
        (dist / "index.html").write_text("<html>spa</html>")
        (dist / "assets" / "index-abc123.js").write_text("console.log('x')")
        patcher = patch("core.views.WEB_DIST", dist)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_root_serves_index_with_no_cache(self):
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Cache-Control"], "no-cache")

    def test_unknown_path_falls_back_to_index_no_cache(self):
        """Неизвестный путь ("/foo/bar") — обычный SPA-роутинг, отдаём
        index.html: сам клиент решает, что показать (см. web/src/App.tsx
        NotFoundScreen), бэкенду разбирать пути клиентского роутера не за чем."""
        resp = self.client.get("/foo/bar")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Cache-Control"], "no-cache")

    def test_existing_asset_served_with_immutable_cache(self):
        resp = self.client.get("/assets/index-abc123.js")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["Cache-Control"], "public, max-age=31536000, immutable")

    def test_missing_asset_is_real_404_not_index_html(self):
        """Регрессия: раньше отсутствующий /assets/<хэш>.js (типичная
        ситуация — вкладка/кэш со старого деплоя, файла с этим хэшем уже
        нет) тихо получал 200 с index.html вместо честного 404. Браузер
        пытался исполнить HTML как JS-модуль и падал с белым экраном без
        единой видимой ошибки в сети."""
        resp = self.client.get("/assets/index-doesnotexist.js")
        self.assertEqual(resp.status_code, 404)
