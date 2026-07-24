from django.contrib import admin

from .models import Channel, Membership, Message, Server


class ChannelInline(admin.TabularInline):
    model = Channel
    extra = 0


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0


@admin.register(Server)
class ServerAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "created_at")
    search_fields = ("name", "owner__username")
    inlines = [ChannelInline, MembershipInline]


@admin.register(Channel)
class ChannelAdmin(admin.ModelAdmin):
    list_display = ("name", "server", "kind", "position")
    list_filter = ("kind", "server")
    search_fields = ("name",)


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "server", "joined_at")
    search_fields = ("user__username", "server__name")


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ("author", "channel", "created_at", "edited_at")
    list_filter = ("channel__server",)
    search_fields = ("content", "author__username")
    raw_id_fields = ("reply_to",)
