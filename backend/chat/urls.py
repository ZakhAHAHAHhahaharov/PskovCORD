from django.urls import path

from . import views

urlpatterns = [
    path("config", views.config_view, name="config"),

    path("servers", views.ServerListCreate.as_view(), name="server-list"),
    path("servers/discover", views.ServerDiscover.as_view(), name="server-discover"),
    path("servers/<int:server_id>", views.ServerDetail.as_view(), name="server-detail"),
    path("servers/<int:server_id>/join", views.ServerJoin.as_view(), name="server-join"),
    path("servers/<int:server_id>/members",
         views.ServerMembers.as_view(), name="server-members"),
    path("servers/<int:server_id>/channels",
         views.ChannelCreate.as_view(), name="channel-create"),

    path("channels/<int:channel_id>/messages",
         views.ChannelMessages.as_view(), name="channel-messages"),
    path("channels/<int:channel_id>/voice-members",
         views.ChannelVoiceMembers.as_view(), name="channel-voice-members"),
    path("channels/<int:channel_id>/livekit-token",
         views.LiveKitToken.as_view(), name="livekit-token"),
]
