"""
GatewayConsumer — единственный WebSocket на клиента (по образу Discord gateway).

Через него идут: realtime-сообщения, presence (online/offline) и voice-state
(кто вошёл/вышел из голосового канала). Клиент подключается с JWT в query:
    ws://host/ws/gateway?token=<access>

Операции клиент -> сервер (JSON, поле "op"):
    {"op": "send_message", "channel_id": <id>, "content": "..."}
    {"op": "voice_join",   "channel_id": <id>}
    {"op": "voice_leave"}
    {"op": "voice_offer",         "to_user_id": <id>, "sdp": "..."}
    {"op": "voice_answer",        "to_user_id": <id>, "sdp": "..."}
    {"op": "voice_ice_candidate", "to_user_id": <id>, "candidate": {...}}

События сервер -> клиент:
    {"op": "ready", "user": {...}}
    {"op": "message_create", "message": {...}}
    {"op": "presence_update", "user_id": <id>, "online": bool}
    {"op": "voice_state_update", "user_id": <id>, "channel_id": <id|null>}
    {"op": "voice_peers", "channel_id": <id>, "peer_ids": [<id>, ...]}
    {"op": "voice_offer",         "from_user_id": <id>, "sdp": "..."}
    {"op": "voice_answer",        "from_user_id": <id>, "sdp": "..."}
    {"op": "voice_ice_candidate", "from_user_id": <id>, "candidate": {...}}

WebRTC-сигналинг (voice_offer/voice_answer/voice_ice_candidate) — прямой relay
1:1 через персональную группу "user_{id}" (см. connect()/disconnect()).
Сервер релеит только между участниками одного и того же voice-канала (см.
_handle_voice_relay); mesh — новый участник всегда инициирует offer ко всем,
кого получил в voice_peers, остальные только отвечают.
"""
import asyncio
import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from . import presence
from .models import Channel, Membership, Message
from .serializers import MessageSerializer


class GatewayConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope.get("user")
        if not self.user or not self.user.is_authenticated:
            await self.close(code=4001)
            return

        self.uid = str(self.user.id)
        self.server_groups = []

        await self.accept()

        for sid in await self._server_ids():
            group = f"server_{sid}"
            self.server_groups.append(group)
            await self.channel_layer.group_add(group, self.channel_name)

        self.user_group = f"user_{self.uid}"
        await self.channel_layer.group_add(self.user_group, self.channel_name)

        await asyncio.to_thread(presence.user_connected, self.uid)
        await self._broadcast_presence(True)

        await self._send({
            "op": "ready",
            "user": {"id": self.user.id, "username": self.user.username},
        })

    async def disconnect(self, code):
        user = getattr(self, "user", None)
        if not user or not user.is_authenticated:
            return

        prev_voice = await asyncio.to_thread(presence.voice_channel, self.uid)
        remaining = await asyncio.to_thread(presence.user_disconnected, self.uid)

        for group in getattr(self, "server_groups", []):
            await self.channel_layer.group_discard(group, self.channel_name)
        if getattr(self, "user_group", None):
            await self.channel_layer.group_discard(self.user_group, self.channel_name)

        if remaining == 0:
            if prev_voice:
                server_id = await self._channel_server(prev_voice)
                await self._broadcast_voice(self.user.id, None, server_id)
            await self._broadcast_presence(False)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data or "{}")
        except (ValueError, TypeError):
            return

        op = data.get("op")
        if op == "send_message":
            await self._handle_send(data)
        elif op == "voice_join":
            await self._handle_voice_join(data)
        elif op == "voice_leave":
            await self._handle_voice_leave()
        elif op in ("voice_offer", "voice_answer", "voice_ice_candidate"):
            await self._handle_voice_relay(op, data)

    # --- операции -----------------------------------------------------------
    async def _handle_send(self, data):
        channel_id = data.get("channel_id")
        content = (data.get("content") or "").strip()
        if not channel_id or not content:
            return
        result = await self._create_message(channel_id, content[:4000])
        if not result:
            return
        await self.channel_layer.group_send(
            f"server_{result['server_id']}",
            {"type": "broadcast", "payload": {
                "op": "message_create", "message": result["data"]}},
        )

    async def _handle_voice_join(self, data):
        channel_id = data.get("channel_id")
        if not channel_id:
            return
        server_id = await self._voice_channel_server(channel_id)
        if not server_id:
            return
        peer_ids = await asyncio.to_thread(
            presence.join_voice, self.uid, channel_id)
        await self._broadcast_voice(self.user.id, channel_id, server_id)
        await self._send({
            "op": "voice_peers",
            "channel_id": channel_id,
            "peer_ids": [int(p) for p in peer_ids],
        })

    async def _handle_voice_leave(self):
        prev = await asyncio.to_thread(presence.clear_voice, self.uid)
        if prev:
            server_id = await self._channel_server(prev)
            await self._broadcast_voice(self.user.id, None, server_id)

    async def _handle_voice_relay(self, op, data):
        to_user_id = data.get("to_user_id")
        if not to_user_id:
            return
        my_channel = await asyncio.to_thread(presence.voice_channel, self.uid)
        their_channel = await asyncio.to_thread(
            presence.voice_channel, str(to_user_id))
        if not my_channel or my_channel != their_channel:
            return
        payload = {"op": op, "from_user_id": self.user.id}
        if op == "voice_ice_candidate":
            payload["candidate"] = data.get("candidate")
        else:
            payload["sdp"] = data.get("sdp")
        await self.channel_layer.group_send(
            f"user_{to_user_id}", {"type": "broadcast", "payload": payload})

    # --- рассылка -----------------------------------------------------------
    async def _broadcast_presence(self, online: bool):
        payload = {
            "op": "presence_update",
            "user_id": self.user.id,
            "username": self.user.username,
            "avatar_color": self.user.avatar_color,
            "online": online,
        }
        for group in self.server_groups:
            await self.channel_layer.group_send(
                group, {"type": "broadcast", "payload": payload})

    async def _broadcast_voice(self, user_id, channel_id, server_id):
        if not server_id:
            return
        payload = {
            "op": "voice_state_update",
            "user_id": user_id,
            "username": self.user.username,
            "avatar_color": self.user.avatar_color,
            "channel_id": channel_id,
            "server_id": server_id,
        }
        # Только участникам этого сервера.
        await self.channel_layer.group_send(
            f"server_{server_id}", {"type": "broadcast", "payload": payload})

    async def broadcast(self, event):
        """Обработчик group_send(type="broadcast")."""
        await self._send(event["payload"])

    async def _send(self, obj):
        await self.send(text_data=json.dumps(obj))

    # --- БД (sync -> async) -------------------------------------------------
    @database_sync_to_async
    def _server_ids(self):
        return list(
            Membership.objects.filter(user=self.user).values_list(
                "server_id", flat=True)
        )

    @database_sync_to_async
    def _create_message(self, channel_id, content):
        try:
            channel = Channel.objects.select_related("server").get(id=channel_id)
        except Channel.DoesNotExist:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        msg = Message.objects.create(
            channel=channel, author=self.user, content=content)
        return {"server_id": channel.server_id, "data": MessageSerializer(msg).data}

    @database_sync_to_async
    def _voice_channel_server(self, channel_id):
        """server_id, если это голосовой канал и юзер — участник сервера, иначе None."""
        try:
            channel = Channel.objects.select_related("server").get(id=channel_id)
        except Channel.DoesNotExist:
            return None
        if channel.kind != Channel.VOICE:
            return None
        if not Membership.objects.filter(
            user=self.user, server=channel.server
        ).exists():
            return None
        return channel.server_id

    @database_sync_to_async
    def _channel_server(self, channel_id):
        try:
            return Channel.objects.get(id=channel_id).server_id
        except Channel.DoesNotExist:
            return None
