from django import forms
from django.contrib import admin
from django.utils.html import format_html

from .models import Favicon


class FaviconAdminForm(forms.ModelForm):
    # Не привязано к модели напрямую (Favicon.original — editable=False):
    # сырой файл сперва нужно обработать Pillow'ом (см. Favicon.process),
    # автосейв стокового ImageField тут не подходит.
    upload = forms.ImageField(
        label="Изображение",
        required=False,
        help_text="Обрежется до квадрата по центру и сожмётся под нужные размеры автоматически.",
    )

    class Meta:
        model = Favicon
        fields = ["is_default"]

    def clean(self):
        cleaned = super().clean()
        if not self.instance.pk and not cleaned.get("upload"):
            raise forms.ValidationError("Нужно выбрать файл изображения.")
        return cleaned


@admin.register(Favicon)
class FaviconAdmin(admin.ModelAdmin):
    form = FaviconAdminForm
    list_display = ("thumbnail", "id", "uploaded_by", "is_default", "created_at")
    list_filter = ("is_default",)
    search_fields = ("uploaded_by__username", "id")

    @admin.display(description="Превью")
    def thumbnail(self, obj):
        if not obj.pk or not obj.original:
            return "—"
        return format_html(
            '<img src="{}" style="width:32px;height:32px;border-radius:4px;object-fit:cover" />',
            obj.original.url,
        )

    def get_fields(self, request, obj=None):
        if obj is None:
            return ("upload", "is_default")
        return ("thumbnail", "upload", "is_default", "uploaded_by", "created_at", "id")

    def get_readonly_fields(self, request, obj=None):
        if obj is None:
            return ()
        return ("id", "uploaded_by", "created_at", "thumbnail")

    def save_model(self, request, obj, form, change):
        if not change:
            obj.uploaded_by = request.user
        upload = form.cleaned_data.get("upload")
        if upload:
            obj.process(upload)
        obj.save()
