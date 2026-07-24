from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class PskovCordUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (
        ("PskovCord", {"fields": ("avatar_color", "status")}),
    )
    list_display = ("username", "email", "status", "is_staff", "is_active")
    list_filter = UserAdmin.list_filter + ("status",)
