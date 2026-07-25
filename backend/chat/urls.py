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
    path("channels/<int:channel_id>/voice-credentials",
         views.VoiceCredentials.as_view(), name="voice-credentials"),

    path("friends", views.FriendsView.as_view(), name="friends"),
    path("friends/requests", views.FriendRequests.as_view(), name="friend-requests"),
    path("friends/requests/<int:request_id>/accept",
         views.FriendRequestAccept.as_view(), name="friend-request-accept"),
    path("friends/requests/<int:request_id>",
         views.FriendRequestDecline.as_view(), name="friend-request-decline"),
    path("friends/<int:user_id>", views.FriendRemove.as_view(), name="friend-remove"),

    path("people/known", views.KnownPeople.as_view(), name="known-people"),

    path("conversations", views.ConversationListCreate.as_view(), name="conversation-list"),
    path("conversations/<int:conversation_id>/messages",
         views.ConversationMessages.as_view(), name="conversation-messages"),
    path("conversations/<int:conversation_id>/voice-credentials",
         views.ConversationVoiceCredentials.as_view(),
         name="conversation-voice-credentials"),
]
