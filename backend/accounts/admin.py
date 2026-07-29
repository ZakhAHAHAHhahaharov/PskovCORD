from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import NameFont, User


@admin.register(User)
class PskovCordUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (
        ("PskovCord", {"fields": ("avatar_color", "status", "favicon")}),
    )
    list_display = ("username", "email", "status", "is_staff", "is_active")
    list_filter = UserAdmin.list_filter + ("status",)
    # Favicon.__str__ уже содержит id/uploaded_by — обычный select был бы неудобен
    # при росте таблицы иконок, raw_id даёт быстрый поиск по popup вместо long-list.
    raw_id_fields = ("favicon",)


@admin.register(NameFont)
class NameFontAdmin(admin.ModelAdmin):
    """В отличие от core.FaviconAdmin, тут не нужна отдельная форма — файл
    шрифта не требует Pillow-обработки перед сохранением, обычный FileField
    прекрасно сохраняется автосейвом ModelForm."""

    list_display = ("label", "uploaded_by", "created_at")
    search_fields = ("label",)
    readonly_fields = ("uploaded_by", "created_at")

    def get_readonly_fields(self, request, obj=None):
        if obj is None:
            return ()
        return self.readonly_fields

    def save_model(self, request, obj, form, change):
        if not change:
            obj.uploaded_by = request.user
        super().save_model(request, obj, form, change)
