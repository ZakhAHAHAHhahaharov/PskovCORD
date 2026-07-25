from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


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
