"""
Тесты голосовой «меты» (presence/peers/mute), SFU access-токена и TURN-хелпера.
Медиа-транспорт голоса вынесен в отдельный SFU-сервис (mediasoup), поэтому
mesh-сигналинга offer/answer/ice в gateway больше нет.
"""
import asyncio
import base64
from datetime import timedelta
import hashlib
import hmac
import io
import json
import re
import time
from pathlib import Path

import jwt
from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from PIL import Image as PILImage
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from . import emoji as emoji_keys, mute_vote, presence, roles, sfu, turn
from .consumers import GatewayConsumer
from accounts.models import Friendship

from .middleware import JWTAuthMiddleware
from .models import (
    Attachment, Channel, Conversation, ConversationMessage,
    ConversationParticipant, MAX_ATTACHMENT_BYTES, MAX_REACTIONS_PER_MESSAGE,
    FriendNickname, Membership, Message, ProfileNote, Reaction, Role, Server, ServerBan,
    ServerInvite, ServerJoinRequest, dm_room,
)
from .permissions import can_dm

User = get_user_model()


class PresenceVoiceTests(TestCase):
    def setUp(self):
        presence._r.flushdb()

    def tearDown(self):
        presence._r.flushdb()

    def test_first_member_has_no_peers(self):
        peers, emptied = presence.join_voice(1, 100)
        self.assertEqual(peers, [])
        self.assertIsNone(emptied)
        self.assertEqual(presence.voice_member_ids(100), {"1"})

    def test_second_member_sees_first_as_peer(self):
        presence.join_voice(1, 100)
        peers, _ = presence.join_voice(2, 100)
        self.assertEqual(peers, ["1"])

    def test_join_moves_between_channels(self):
        presence.join_voice(1, 100)
        peers, emptied = presence.join_voice(1, 200)
        self.assertEqual(presence.voice_member_ids(100), set())
        self.assertEqual(presence.voice_member_ids(200), {"1"})
        self.assertEqual(emptied, "100")

    def test_peers_never_include_self(self):
        presence.join_voice(1, 100)
        peers, _ = presence.join_voice(1, 100)  # повторный join тем же uid
        self.assertEqual(peers, [])

    def test_voice_flags_default_to_false(self):
        self.assertEqual(
            presence.voice_flags(1),
            {"muted": False, "deafened": False, "sharing_screen": False},
        )

    def test_voice_flags_roundtrip(self):
        presence.set_voice_flags(1, muted=True, deafened=False)
        self.assertEqual(
            presence.voice_flags(1),
            {"muted": True, "deafened": False, "sharing_screen": False},
        )

    def test_screen_sharing_roundtrip_independent_of_mute(self):
        presence.set_voice_flags(1, muted=True, deafened=False)
        presence.set_screen_sharing(1, True)
        self.assertEqual(
            presence.voice_flags(1),
            {"muted": True, "deafened": False, "sharing_screen": True},
        )

    def test_voice_members_flags_bulk(self):
        presence.join_voice(1, 100)
        presence.join_voice(2, 100)
        presence.set_voice_flags(1, muted=True, deafened=True)
        flags = presence.voice_members_flags(100)
        self.assertEqual(
            flags["1"], {"muted": True, "deafened": True, "sharing_screen": False})
        self.assertEqual(
            flags["2"], {"muted": False, "deafened": False, "sharing_screen": False})

    def test_clear_voice_resets_flags(self):
        presence.join_voice(1, 100)
        presence.set_voice_flags(1, muted=True, deafened=True)
        presence.set_screen_sharing(1, True)
        presence.clear_voice(1)
        self.assertEqual(
            presence.voice_flags(1),
            {"muted": False, "deafened": False, "sharing_screen": False},
        )


class CallStateTests(TestCase):
    """Длительность разговора и статус канала (voice_call_state) — живут в
    presence только пока в голосовом канале хоть кто-то есть."""

    def setUp(self):
        presence._r.flushdb()

    def tearDown(self):
        presence._r.flushdb()

    def test_first_join_starts_call(self):
        self.assertIsNone(presence.call_started_at(100))
        presence.join_voice(1, 100)
        self.assertIsNotNone(presence.call_started_at(100))

    def test_second_join_does_not_reset_start_time(self):
        presence.join_voice(1, 100)
        started = presence.call_started_at(100)
        presence.join_voice(2, 100)
        self.assertEqual(presence.call_started_at(100), started)

    def test_last_leave_clears_call_state(self):
        presence.join_voice(1, 100)
        presence.set_call_topic(100, "болтаем")
        presence.clear_voice(1)
        self.assertIsNone(presence.call_started_at(100))
        self.assertIsNone(presence.call_topic(100))

    def test_leave_with_others_remaining_keeps_call_state(self):
        presence.join_voice(1, 100)
        presence.join_voice(2, 100)
        presence.set_call_topic(100, "болтаем")
        presence.clear_voice(1)
        self.assertIsNotNone(presence.call_started_at(100))
        self.assertEqual(presence.call_topic(100), "болтаем")

    def test_switching_channel_clears_old_if_emptied(self):
        presence.join_voice(1, 100)
        presence.set_call_topic(100, "было")
        presence.join_voice(1, 200)  # переключился, 100 опустел
        self.assertIsNone(presence.call_started_at(100))
        self.assertIsNone(presence.call_topic(100))
        self.assertIsNotNone(presence.call_started_at(200))

    def test_switching_channel_keeps_old_if_not_emptied(self):
        presence.join_voice(1, 100)
        presence.join_voice(2, 100)
        presence.join_voice(1, 200)  # 100 всё ещё не пуст (там #2)
        self.assertIsNotNone(presence.call_started_at(100))

    def test_empty_topic_clears_it(self):
        presence.join_voice(1, 100)
        presence.set_call_topic(100, "тема")
        presence.set_call_topic(100, "")
        self.assertIsNone(presence.call_topic(100))


class _FakeChannelLayer:
    """Минимальная замена реальному channel_layer для mute_vote.resolve() —
    тому нужен только awaitable group_send (см. asgiref.sync.async_to_sync
    внутри chat.mute_vote), сама рассылка проверяется по .sent."""

    def __init__(self):
        self.sent = []

    async def group_send(self, group, message):
        self.sent.append((group, message["payload"]))


class MuteVoteTests(TestCase):
    """Redis-хелперы голосования (presence.py) и его резолюция (mute_vote.py) —
    см. chat.consumers._handle_voice_mute_vote_start/_cast и vote_sweep.py,
    которые эту же логику зовут по WS/из фонового потока."""

    def setUp(self):
        presence._r.flushdb()
        self.owner = User.objects.create_user(username="mv_owner", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        self.channel = Channel.objects.create(
            server=self.server, name="v", kind=Channel.VOICE, position=0)

    def tearDown(self):
        presence._r.flushdb()

    def test_second_start_rejected_while_active(self):
        self.assertTrue(presence.start_mute_vote(self.channel.id, 2, 1, 20))
        self.assertFalse(presence.start_mute_vote(self.channel.id, 3, 1, 20))

    def test_cast_rejects_double_vote(self):
        presence.start_mute_vote(self.channel.id, 2, 1, 20)
        self.assertTrue(presence.cast_mute_vote(self.channel.id, 1, True))
        self.assertFalse(presence.cast_mute_vote(self.channel.id, 1, False))

    def test_eligible_excludes_target(self):
        presence.join_voice(1, self.channel.id)
        presence.join_voice(2, self.channel.id)
        presence.join_voice(3, self.channel.id)
        self.assertEqual(
            presence.mute_vote_eligible_ids(self.channel.id, 2), {"1", "3"})

    def test_resolve_majority_for_forces_mute_and_broadcasts(self):
        presence.join_voice(1, self.channel.id)
        presence.join_voice(2, self.channel.id)
        presence.join_voice(3, self.channel.id)
        presence.start_mute_vote(self.channel.id, 2, 1, 20)
        presence.cast_mute_vote(self.channel.id, 1, True)
        presence.cast_mute_vote(self.channel.id, 3, True)

        layer = _FakeChannelLayer()
        mute_vote.resolve(self.channel.id, layer)

        self.assertIsNotNone(presence.forced_mute_until(2))
        self.assertTrue(presence.voice_flags(2)["muted"])
        self.assertIsNone(presence.active_mute_vote(self.channel.id))
        self.assertNotIn(str(self.channel.id), presence.active_vote_channel_ids())

        ops = [payload["op"] for _group, payload in layer.sent]
        self.assertIn("voice_mute_vote_result", ops)
        self.assertIn("voice_mute_update", ops)
        self.assertIn("voice_forced_mute", ops)
        result = next(p for _g, p in layer.sent if p["op"] == "voice_mute_vote_result")
        self.assertTrue(result["muted"])
        forced = next(p for _g, p in layer.sent if p["op"] == "voice_forced_mute")
        self.assertGreater(forced["until"], time.time())

    def test_resolve_tie_does_not_mute(self):
        presence.join_voice(1, self.channel.id)
        presence.join_voice(2, self.channel.id)
        presence.join_voice(3, self.channel.id)
        presence.start_mute_vote(self.channel.id, 2, 1, 20)
        presence.cast_mute_vote(self.channel.id, 1, True)
        presence.cast_mute_vote(self.channel.id, 3, False)

        layer = _FakeChannelLayer()
        mute_vote.resolve(self.channel.id, layer)

        self.assertIsNone(presence.forced_mute_until(2))
        result = next(p for _g, p in layer.sent if p["op"] == "voice_mute_vote_result")
        self.assertFalse(result["muted"])
        self.assertEqual([p["op"] for _g, p in layer.sent], ["voice_mute_vote_result"])

    def test_resolve_without_active_vote_is_noop(self):
        layer = _FakeChannelLayer()
        mute_vote.resolve(self.channel.id, layer)
        self.assertEqual(layer.sent, [])


class EffectiveStatusTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="statususer", password="pw12345")

    def test_offline_regardless_of_choice(self):
        self.user.status = User.DND
        self.assertEqual(presence.effective_status(self.user, online=False), "offline")

    def test_invisible_masked_as_offline_when_online(self):
        self.user.status = User.INVISIBLE
        self.assertEqual(presence.effective_status(self.user, online=True), "offline")

    def test_dnd_visible_when_online(self):
        self.user.status = User.DND
        self.assertEqual(presence.effective_status(self.user, online=True), "dnd")

    def test_online_visible_when_online(self):
        self.user.status = User.ONLINE
        self.assertEqual(presence.effective_status(self.user, online=True), "online")


class ServerMembersStatusTests(APITestCase):
    def setUp(self):
        self.alice = User.objects.create_user(username="alice3", password="pw12345")
        self.bob = User.objects.create_user(username="bob3", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.alice)
        for u in (self.alice, self.bob):
            Membership.objects.create(user=u, server=self.server)

    def _members(self):
        self.client.force_authenticate(self.alice)
        resp = self.client.get(f"/api/servers/{self.server.id}/members")
        self.assertEqual(resp.status_code, 200)
        return {m["username"]: m for m in resp.data}

    def test_offline_member_shows_offline(self):
        members = self._members()
        self.assertEqual(members["bob3"]["status"], "offline")
        self.assertFalse(members["bob3"]["online"])

    def test_invisible_online_member_masked_as_offline(self):
        presence.user_connected(self.bob.id)
        self.bob.status = User.INVISIBLE
        self.bob.save(update_fields=["status"])
        try:
            members = self._members()
            self.assertEqual(members["bob3"]["status"], "offline")
            self.assertFalse(members["bob3"]["online"])
        finally:
            presence.user_disconnected(self.bob.id)

    def test_dnd_online_member_shows_dnd(self):
        presence.user_connected(self.bob.id)
        self.bob.status = User.DND
        self.bob.save(update_fields=["status"])
        try:
            members = self._members()
            self.assertEqual(members["bob3"]["status"], "dnd")
            self.assertTrue(members["bob3"]["online"])
        finally:
            presence.user_disconnected(self.bob.id)


class TurnCredentialsTests(TestCase):
    def test_credential_matches_hmac_sha1(self):
        ice = turn.ice_servers(user_id=42, ttl=60)
        turn_entry = next(s for s in ice if "username" in s)
        username, credential = turn_entry["username"], turn_entry["credential"]

        expected = base64.b64encode(
            hmac.new(
                settings.TURN_SECRET.encode(), username.encode(), hashlib.sha1
            ).digest()
        ).decode()
        self.assertEqual(credential, expected)

        exp, uid = username.split(":")
        self.assertEqual(uid, "42")
        self.assertGreater(int(exp), int(time.time()))

    def test_ice_servers_has_stun_and_turn(self):
        ice = turn.ice_servers(user_id=1)
        urls = [u for s in ice for u in s["urls"]]
        self.assertTrue(any(u.startswith("stun:") for u in urls))
        self.assertTrue(any(u.startswith("turn:") for u in urls))


class VoiceCredentialsViewTests(APITestCase):
    def setUp(self):
        self.member = User.objects.create_user(username="alice", password="pw12345")
        self.stranger = User.objects.create_user(username="bob", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.member)
        Membership.objects.create(user=self.member, server=self.server)
        self.voice_channel = Channel.objects.create(
            server=self.server, name="v", kind=Channel.VOICE, position=0)
        self.text_channel = Channel.objects.create(
            server=self.server, name="t", kind=Channel.TEXT, position=1)

    def test_member_gets_sfu_credentials(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(f"/api/channels/{self.voice_channel.id}/voice-credentials")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("sfu_url", resp.data)
        self.assertIn("sfu_token", resp.data)
        # Токен подписан SFU_SECRET и несёт, кто и в какой канал заходит.
        claims = jwt.decode(
            resp.data["sfu_token"], settings.SFU_SECRET, algorithms=["HS256"])
        self.assertEqual(claims["uid"], self.member.id)
        self.assertEqual(claims["room"], str(self.voice_channel.id))

    def test_non_member_forbidden(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.post(f"/api/channels/{self.voice_channel.id}/voice-credentials")
        self.assertEqual(resp.status_code, 403)

    def test_text_channel_rejected(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(f"/api/channels/{self.text_channel.id}/voice-credentials")
        self.assertEqual(resp.status_code, 400)


class ServerMembersMicStatusTests(APITestCase):
    """/servers/<id>/members должен отдавать muted/deafened для всех — чтобы
    их было видно даже тем, кто сам не подключён к голосовому каналу."""

    def setUp(self):
        presence._r.flushdb()
        self.viewer = User.objects.create_user(username="viewer1", password="pw12345")
        self.talker = User.objects.create_user(username="talker1", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.viewer)
        for u in (self.viewer, self.talker):
            Membership.objects.create(user=u, server=self.server)
        self.voice_channel = Channel.objects.create(
            server=self.server, name="v", kind=Channel.VOICE, position=0)

    def tearDown(self):
        presence._r.flushdb()

    def test_defaults_to_false(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f"/api/servers/{self.server.id}/members")
        talker_row = next(r for r in resp.data if r["username"] == "talker1")
        self.assertEqual(talker_row["muted"], False)
        self.assertEqual(talker_row["deafened"], False)
        self.assertEqual(talker_row["sharing_screen"], False)

    def test_reflects_current_flags_without_being_in_the_channel(self):
        presence.join_voice(self.talker.id, self.voice_channel.id)
        presence.set_voice_flags(self.talker.id, muted=True, deafened=True)
        presence.set_screen_sharing(self.talker.id, True)

        # viewer не в голосовом канале вообще — но статус всё равно виден.
        self.client.force_authenticate(self.viewer)
        resp = self.client.get(f"/api/servers/{self.server.id}/members")
        talker_row = next(r for r in resp.data if r["username"] == "talker1")
        self.assertEqual(talker_row["muted"], True)
        self.assertEqual(talker_row["deafened"], True)
        self.assertEqual(talker_row["sharing_screen"], True)


class ChannelCreatePermissionTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner1", password="pw12345")
        self.member = User.objects.create_user(username="member1", password="pw12345")
        self.stranger = User.objects.create_user(username="stranger1", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)

    def test_owner_can_create_channel(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/channels",
            {"name": "объявления", "kind": "text"},
        )
        self.assertEqual(resp.status_code, 201)

    def test_regular_member_forbidden(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/channels",
            {"name": "объявления", "kind": "text"},
        )
        self.assertEqual(resp.status_code, 403)

    def test_non_member_forbidden(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/channels",
            {"name": "объявления", "kind": "text"},
        )
        self.assertEqual(resp.status_code, 403)


class ServerRolePermissionTests(APITestCase):
    """Права из ролей (chat/roles.py): роль по умолчанию действует на всех,
    выданная роль добавляет права, владелец всегда может всё."""

    def setUp(self):
        self.owner = User.objects.create_user(username="rp_owner", password="pw12345")
        self.member = User.objects.create_user(username="rp_member", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        self.membership = Membership.objects.create(user=self.member, server=self.server)
        self.default_role = roles.create_default_role(self.server)

    def test_owner_has_every_permission(self):
        perms = roles.permissions_for(self.owner, self.server)
        self.assertTrue(all(perms.values()))

    def test_plain_member_gets_only_default_role_permissions(self):
        perms = roles.permissions_for(self.member, self.server)
        self.assertTrue(perms["send_messages"])
        self.assertFalse(perms["manage_server"])

    def test_granted_role_adds_permission(self):
        role = Role.objects.create(
            server=self.server, name="модер", manage_server=True)
        self.membership.roles.add(role)
        perms = roles.permissions_for(self.member, self.server)
        self.assertTrue(perms["manage_server"])
        # Права складываются, а не заменяются — базовые остаются.
        self.assertTrue(perms["send_messages"])

    def test_non_member_has_no_permissions(self):
        stranger = User.objects.create_user(username="rp_stranger", password="pw12345")
        perms = roles.permissions_for(stranger, self.server)
        self.assertFalse(any(perms.values()))

    def test_default_role_can_revoke_sending(self):
        self.default_role.send_messages = False
        self.default_role.save(update_fields=["send_messages"])
        perms = roles.permissions_for(self.member, self.server)
        self.assertFalse(perms["send_messages"])

    def test_server_without_default_role_falls_back_to_base(self):
        """Роль по умолчанию удалили мимо API — участник остаётся рядовым,
        а не теряет вообще всё (см. roles.BASE_MEMBER_PERMISSIONS)."""
        self.default_role.delete()
        perms = roles.permissions_for(self.member, self.server)
        self.assertTrue(perms["send_messages"])
        self.assertFalse(perms["manage_server"])

    def test_patch_server_requires_manage_server(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}", {"name": "чужой"}, format="json")
        self.assertEqual(resp.status_code, 403)

        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}", {"name": "новое имя"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.server.refresh_from_db()
        self.assertEqual(self.server.name, "новое имя")

    def test_roles_crud_requires_manage_roles(self):
        self.client.force_authenticate(self.member)
        self.assertEqual(
            self.client.post(
                f"/api/servers/{self.server.id}/roles", {"name": "x"}, format="json",
            ).status_code,
            403,
        )

        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/roles", {"name": "модер"}, format="json")
        self.assertEqual(resp.status_code, 201)
        role_id = resp.data["id"]
        # Роль по умолчанию через API не создаётся — только вместе с сервером.
        self.assertFalse(resp.data["is_default"])
        self.assertEqual(
            self.client.delete(
                f"/api/servers/{self.server.id}/roles/{role_id}").status_code,
            204,
        )

    def test_default_role_cannot_be_deleted(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.delete(
            f"/api/servers/{self.server.id}/roles/{self.default_role.id}")
        self.assertEqual(resp.status_code, 400)

    def test_member_role_assignment(self):
        role = Role.objects.create(server=self.server, name="модер")
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/members/{self.member.id}",
            {"role_ids": [role.id, self.default_role.id]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        # Роль по умолчанию не выдаётся персонально — молча отбрасывается.
        self.assertEqual(list(self.membership.roles.values_list("id", flat=True)), [role.id])


class OwnerRoleTests(APITestCase):
    """Редактируемая роль "Владелец" (Role.is_owner_role) — владелец может
    сознательно урезать себе часть прав, но не manage_server/manage_roles
    (см. roles.OWNER_LOCKED_PERMISSIONS — иначе навсегда потерял бы доступ
    к собственным настройкам, заступиться некому)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="or_owner", password="pw12345")
        self.admin = User.objects.create_user(username="or_admin", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        admin_membership = Membership.objects.create(user=self.admin, server=self.server)
        roles.create_default_role(self.server)
        admin_role = Role.objects.create(
            server=self.server, name="admin", manage_roles=True, manage_members=True)
        admin_membership.roles.add(admin_role)

    def test_owner_role_is_lazily_created_on_first_list(self):
        self.assertFalse(self.server.roles.filter(is_owner_role=True).exists())
        self.client.force_authenticate(self.owner)
        resp = self.client.get(f"/api/servers/{self.server.id}/roles")
        self.assertEqual(resp.status_code, 200)
        owner_roles = [r for r in resp.data if r["is_owner_role"]]
        self.assertEqual(len(owner_roles), 1)
        self.assertTrue(owner_roles[0]["manage_server"])

    def test_owner_can_revoke_own_non_locked_permission(self):
        owner_role = roles.create_owner_role(self.server)
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{owner_role.id}",
            {"delete_messages": False}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.data["delete_messages"])
        perms = roles.permissions_for(self.owner, self.server)
        self.assertFalse(perms["delete_messages"])
        # Остальное не задели.
        self.assertTrue(perms["send_messages"])

    def test_locked_permissions_stay_true_even_if_client_sends_false(self):
        owner_role = roles.create_owner_role(self.server)
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{owner_role.id}",
            {"manage_server": False, "manage_roles": False}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.data["manage_server"])
        self.assertTrue(resp.data["manage_roles"])
        perms = roles.permissions_for(self.owner, self.server)
        self.assertTrue(perms["manage_server"])
        self.assertTrue(perms["manage_roles"])

    def test_non_owner_admin_cannot_edit_owner_role(self):
        owner_role = roles.create_owner_role(self.server)
        # admin реально держит manage_roles — но роль владельца не про это.
        self.client.force_authenticate(self.admin)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{owner_role.id}",
            {"delete_messages": False}, format="json")
        self.assertEqual(resp.status_code, 403)
        owner_role.refresh_from_db()
        self.assertTrue(owner_role.delete_messages)

    def test_owner_role_cannot_be_deleted(self):
        owner_role = roles.create_owner_role(self.server)
        self.client.force_authenticate(self.owner)
        resp = self.client.delete(
            f"/api/servers/{self.server.id}/roles/{owner_role.id}")
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(Role.objects.filter(id=owner_role.id).exists())

    def test_api_cannot_create_second_owner_role(self):
        roles.create_owner_role(self.server)
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/roles",
            {"name": "Владелец 2", "is_owner_role": True}, format="json")
        self.assertEqual(resp.status_code, 201)
        self.assertFalse(resp.data["is_owner_role"])

    def test_member_ids_with_permission_excludes_owner_after_self_revoke(self):
        owner_role = roles.create_owner_role(self.server)
        owner_role.delete_messages = False
        owner_role.save(update_fields=["delete_messages"])
        ids = roles.member_ids_with_permission(self.server, "delete_messages")
        self.assertNotIn(self.owner.id, ids)


class ServerAccessTests(APITestCase):
    """Вкладка «Доступ»: режимы вступления, заявки и баны."""

    def setUp(self):
        self.owner = User.objects.create_user(username="ac_owner", password="pw12345")
        self.outsider = User.objects.create_user(username="ac_out", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        roles.create_default_role(self.server)

    def test_public_server_joins_immediately(self):
        self.client.force_authenticate(self.outsider)
        resp = self.client.post(f"/api/servers/{self.server.id}/join")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            Membership.objects.filter(user=self.outsider, server=self.server).exists())

    def test_invite_only_server_refuses(self):
        self.server.access_mode = Server.ACCESS_INVITE
        self.server.save(update_fields=["access_mode"])
        self.client.force_authenticate(self.outsider)
        resp = self.client.post(f"/api/servers/{self.server.id}/join")
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(
            Membership.objects.filter(user=self.outsider, server=self.server).exists())

    def test_request_mode_creates_join_request_and_approval_adds_member(self):
        self.server.access_mode = Server.ACCESS_REQUEST
        self.server.save(update_fields=["access_mode"])
        self.client.force_authenticate(self.outsider)
        resp = self.client.post(f"/api/servers/{self.server.id}/join")
        self.assertEqual(resp.status_code, 202)
        self.assertFalse(
            Membership.objects.filter(user=self.outsider, server=self.server).exists())

        join_request = ServerJoinRequest.objects.get(
            server=self.server, user=self.outsider)
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/requests/{join_request.id}")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            Membership.objects.filter(user=self.outsider, server=self.server).exists())
        self.assertFalse(ServerJoinRequest.objects.filter(id=join_request.id).exists())

    def test_join_requests_hidden_from_regular_member(self):
        member = User.objects.create_user(username="ac_member", password="pw12345")
        Membership.objects.create(user=member, server=self.server)
        self.client.force_authenticate(member)
        resp = self.client.get(f"/api/servers/{self.server.id}/requests")
        self.assertEqual(resp.status_code, 403)

    def test_ban_removes_membership_and_blocks_rejoin(self):
        Membership.objects.create(user=self.outsider, server=self.server)
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/bans",
            {"user_id": self.outsider.id, "reason": "флуд"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertFalse(
            Membership.objects.filter(user=self.outsider, server=self.server).exists())

        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.post(f"/api/servers/{self.server.id}/join").status_code, 403)

        self.client.force_authenticate(self.owner)
        self.assertEqual(
            self.client.delete(
                f"/api/servers/{self.server.id}/bans/{self.outsider.id}").status_code,
            204,
        )
        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.post(f"/api/servers/{self.server.id}/join").status_code, 200)

    def test_owner_cannot_be_banned(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/bans",
            {"user_id": self.owner.id},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_private_server_is_absent_from_discover_for_outsiders(self):
        """Приватный сервер не виден в поиске вообще — ни строкой, ни именем.

        Раньше он показывался всем с вычищенными description/tags, то есть имя,
        значок и число участников были публичны, а при access_mode=public в
        него можно было ещё и вступить прямо из выдачи.
        """
        self.server.is_private = True
        self.server.description = "секретное описание"
        self.server.tags = ["тайна"]
        self.server.save(update_fields=["is_private", "description", "tags"])

        self.client.force_authenticate(self.outsider)
        ids = [s["id"] for s in self.client.get("/api/servers/discover").data]
        self.assertNotIn(self.server.id, ids)

        # Свой же приватный сервер владелец в списке видит — иначе выдача
        # скрывала бы от человека его собственные сервера.
        self.client.force_authenticate(self.owner)
        entry = next(
            s for s in self.client.get("/api/servers/discover").data
            if s["id"] == self.server.id
        )
        self.assertEqual(entry["description"], "секретное описание")

    def test_private_server_not_found_by_search_query(self):
        """Точный поиск по имени приватного сервера тоже ничего не находит —
        иначе «нет в списке» обходилось бы одним угаданным словом."""
        self.server.is_private = True
        self.server.save(update_fields=["is_private"])

        self.client.force_authenticate(self.outsider)
        resp = self.client.get("/api/servers/discover", {"q": self.server.name})
        self.assertEqual([s["id"] for s in resp.data], [])

    def test_discover_search_filters_by_name_and_tags(self):
        public = Server.objects.create(name="Лампово о рыбалке", owner=self.owner)
        public.tags = ["рыбалка", "оффтоп"]
        public.save(update_fields=["tags"])

        self.client.force_authenticate(self.outsider)
        by_name = self.client.get("/api/servers/discover", {"q": "лампово"})
        self.assertIn(public.id, [s["id"] for s in by_name.data])

        by_tag = self.client.get("/api/servers/discover", {"q": "рыбалка"})
        self.assertIn(public.id, [s["id"] for s in by_tag.data])

        nothing = self.client.get("/api/servers/discover", {"q": "заведомо нет такого"})
        self.assertEqual(list(nothing.data), [])

    def test_server_profile_validation(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}",
            {"banner_gradient": "url(javascript:alert(1))"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

        resp = self.client.patch(
            f"/api/servers/{self.server.id}",
            {
                "banner_gradient": "linear-gradient(90deg, #112233 0%, #445566 100%)",
                "rules": [{"title": "Без флуда", "text": "Не спамьте.", "лишнее": 1}],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        # Лишние ключи в правилах отбрасываются — в JSONField только title/text.
        self.assertEqual(
            resp.data["rules"], [{"title": "Без флуда", "text": "Не спамьте."}])


class GatewayVoiceSignalingTests(TransactionTestCase):
    """WS-уровень: join отдаёт peers, relay работает 1:1 только внутри канала.

    TransactionTestCase, а не TestCase: database_sync_to_async в консьюмере
    открывает соединение с БД в отдельном потоке — atomic-обёртка TestCase
    (единая транзакция на тест) с этим не совместима (InterfaceError:
    connection already closed).
    """

    def setUp(self):
        presence._r.flushdb()
        self.alice = User.objects.create_user(username="alice2", password="pw12345")
        self.bob = User.objects.create_user(username="bob2", password="pw12345")
        self.carol = User.objects.create_user(username="carol2", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.alice)
        for u in (self.alice, self.bob):
            Membership.objects.create(user=u, server=self.server)
        self.voice_channel = Channel.objects.create(
            server=self.server, name="v", kind=Channel.VOICE, position=0)
        # carol намеренно НЕ участник сервера — её WS-подключение не должно
        # рассылать presence в server_{id} группу и мешать проверке ниже.

    def tearDown(self):
        presence._r.flushdb()

    async def _connect(self, user):
        token = str(AccessToken.for_user(user))
        comm = WebsocketCommunicator(
            JWTAuthMiddleware(GatewayConsumer.as_asgi()),
            f"/ws/gateway?token={token}")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    @staticmethod
    async def _receive_until(comm, op, timeout=2, max_messages=10):
        """Читает сообщения, пропуская другие op (presence/voice_state и т.п.),
        пока не найдёт нужный — порядок broadcast vs direct send не гарантирован."""
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            if msg.get("op") == op:
                return msg
        raise AssertionError(f"op={op!r} не пришёл за {max_messages} сообщений")

    @staticmethod
    async def _assert_op_not_received(comm, op, timeout=0.3, interval=0.01):
        """Как receive_nothing (опрашивает очередь напрямую, БЕЗ вызова
        receive_json_from — тот при таймауте отменяет таск consumer'а и ломает
        последующий disconnect()), но допускает прочий шум в очереди (voice_join
        сам рассылает себе сброс sharing_screen и т.п.) — падает, только если
        среди накопившегося оказался именно указанный op."""
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            while not comm.output_queue.empty():
                raw = comm.output_queue.get_nowait()
                if "text" in raw:
                    msg = json.loads(raw["text"])
                    if msg.get("op") == op:
                        raise AssertionError(f"op={op!r} не должен был прийти, но пришёл: {msg}")
            await asyncio.sleep(interval)

    async def _join_and_drain(self, comm, channel_id, timeout=2, max_messages=10):
        """voice_join + дожидается СВОЕГО voice_peers, voice_state_update и
        voice_call_state — идут через group_send (Redis) и могут прийти
        позже voice_peers (прямой self._send), иначе "протекают" в
        последующие проверки (в т.ч. leftover "ready" от connect())."""
        await comm.send_json_to({"op": "voice_join", "channel_id": channel_id})
        peers_msg = None
        seen_own_state = False
        seen_call_state = False
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            op = msg.get("op")
            if op == "voice_peers":
                peers_msg = msg
            elif op == "voice_state_update" and msg.get("channel_id") == channel_id:
                seen_own_state = True
            elif op == "voice_call_state" and msg.get("channel_id") == channel_id:
                seen_call_state = True
            if peers_msg is not None and seen_own_state and seen_call_state:
                return peers_msg
        raise AssertionError("voice_peers/voice_state_update/voice_call_state не пришли за join")

    async def test_join_reports_existing_peers(self):
        # voice_peers — UI-роутер участников канала: первый входящий видит
        # пустой список, следующий — уже присутствующих. Медиа между ними
        # устанавливается не здесь, а через отдельный SFU.
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        peers_msg = await self._join_and_drain(alice_ws, self.voice_channel.id)
        self.assertEqual(peers_msg["peer_ids"], [])

        bob_peers = await self._join_and_drain(bob_ws, self.voice_channel.id)
        self.assertEqual(bob_peers["peer_ids"], [self.alice.id])

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_mute_update_relayed_to_peer_and_seen_in_new_peer_flags(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)

        await alice_ws.send_json_to({
            "op": "voice_mute_update", "muted": True, "deafened": False,
        })
        # bob ещё не в канале — рассылка идёт всем на сервере (не только
        # участникам голосового канала), поэтому просто ждём нужный op.
        seen = await self._receive_until(bob_ws, "voice_mute_update")
        self.assertEqual(seen["user_id"], self.alice.id)
        self.assertTrue(seen["muted"])
        self.assertFalse(seen["deafened"])

        # bob подключается позже — должен сразу увидеть актуальный статус alice.
        bob_peers = await self._join_and_drain(bob_ws, self.voice_channel.id)
        self.assertEqual(
            bob_peers["peer_flags"][str(self.alice.id)],
            {"muted": True, "deafened": False, "sharing_screen": False},
        )

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_screen_share_update_relayed_and_seen_in_new_peer_flags(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        # voice_join сам сбрасывает и рассылает sharing=False на случай, если
        # флаг демки унаследован из предыдущего канала (см. _handle_voice_join) —
        # это тоже долетает до боба, отдельно от явного тоггла ниже.
        join_reset = await self._receive_until(bob_ws, "voice_screen_share_update")
        self.assertEqual(join_reset["user_id"], self.alice.id)
        self.assertFalse(join_reset["sharing"])

        await alice_ws.send_json_to({
            "op": "voice_screen_share_update", "sharing": True,
        })
        # Как и voice_mute_update — рассылка всем на сервере, не только
        # участникам этого голосового канала (бейдж «демка» виден всем).
        seen = await self._receive_until(bob_ws, "voice_screen_share_update")
        self.assertEqual(seen["user_id"], self.alice.id)
        self.assertTrue(seen["sharing"])

        bob_peers = await self._join_and_drain(bob_ws, self.voice_channel.id)
        self.assertEqual(
            bob_peers["peer_flags"][str(self.alice.id)],
            {"muted": False, "deafened": False, "sharing_screen": True},
        )

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_screen_share_update_ignored_when_not_in_voice(self):
        alice_ws = await self._connect(self.alice)  # не в голосе
        bob_ws = await self._connect(self.bob)
        # connect() шлёт bob'у и "ready" (direct), и его собственный
        # presence_update — иначе они "протекут" в проверку receive_nothing.
        await bob_ws.receive_json_from(timeout=2)
        await bob_ws.receive_json_from(timeout=2)

        await alice_ws.send_json_to({
            "op": "voice_screen_share_update", "sharing": True,
        })
        self.assertTrue(await bob_ws.receive_nothing(timeout=0.3))

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_set_status_broadcasts_effective_status(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        # bob получает presence_update о подключении alice (online, статус по умолчанию).
        await self._receive_until(bob_ws, "presence_update")

        await alice_ws.send_json_to({"op": "set_status", "status": "dnd"})
        msg = await self._receive_until(bob_ws, "presence_update")
        self.assertEqual(msg["user_id"], self.alice.id)
        self.assertEqual(msg["status"], "dnd")
        self.assertTrue(msg["online"])

        await alice_ws.send_json_to({"op": "set_status", "status": "invisible"})
        msg = await self._receive_until(bob_ws, "presence_update")
        self.assertEqual(msg["user_id"], self.alice.id)
        self.assertEqual(msg["status"], "offline")
        self.assertFalse(msg["online"])

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_join_broadcasts_call_start_to_everyone(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        started = await self._receive_until(bob_ws, "voice_call_state")
        self.assertEqual(started["channel_id"], self.voice_channel.id)
        self.assertIsNotNone(started["call_started_at"])
        self.assertIsNone(started["topic"])

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_set_status_invalid_value_ignored(self):
        alice_ws = await self._connect(self.alice)
        await self._receive_until(alice_ws, "ready")
        await self._receive_until(alice_ws, "presence_update")

        await alice_ws.send_json_to({"op": "set_status", "status": "bogus"})
        self.assertTrue(await alice_ws.receive_nothing(timeout=0.3))

        await alice_ws.disconnect()

    async def test_topic_update_by_participant_is_broadcast(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        await self._receive_until(bob_ws, "voice_call_state")  # старт разговора

        await alice_ws.send_json_to({"op": "voice_topic_update", "topic": "обсуждаем релиз"})
        seen = await self._receive_until(bob_ws, "voice_call_state")
        self.assertEqual(seen["topic"], "обсуждаем релиз")

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_topic_update_ignored_when_not_in_voice(self):
        bob_ws = await self._connect(self.bob)  # bob нигде не в голосе
        # connect() шлёт bob'у и "ready" (direct), и его собственный
        # presence_update (он тоже участник server_groups) — порядок между
        # ними не гарантирован, но их ровно два.
        await bob_ws.receive_json_from(timeout=2)
        await bob_ws.receive_json_from(timeout=2)

        await bob_ws.send_json_to({"op": "voice_topic_update", "topic": "не должно пройти"})
        self.assertTrue(await bob_ws.receive_nothing(timeout=0.3))

        await bob_ws.disconnect()

    async def test_last_leave_broadcasts_cleared_call_state(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        await self._receive_until(bob_ws, "voice_call_state")  # старт

        await alice_ws.send_json_to({"op": "voice_leave"})
        ended = await self._receive_until(bob_ws, "voice_call_state")
        self.assertIsNone(ended["call_started_at"])
        self.assertIsNone(ended["topic"])

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_wake_user_delivered_when_target_muted(self):
        """«Разбудить мальчика» (ParticipantContextMenu) — доходит, только
        если у цели сейчас выключен микрофон или звук (см.
        _handle_voice_wake_user)."""
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        await self._join_and_drain(bob_ws, self.voice_channel.id)

        await bob_ws.send_json_to({
            "op": "voice_mute_update", "muted": True, "deafened": False,
        })
        await self._receive_until(bob_ws, "voice_mute_update")  # своя же рассылка

        await alice_ws.send_json_to({"op": "voice_wake_user", "target_user_id": self.bob.id})
        seen = await self._receive_until(bob_ws, "voice_wake_requested")
        self.assertEqual(seen["channel_id"], self.voice_channel.id)
        self.assertEqual(seen["from_user_id"], self.alice.id)
        self.assertEqual(seen["from_username"], self.alice.username)

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_wake_user_delivered_when_target_deafened(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        await self._join_and_drain(bob_ws, self.voice_channel.id)

        await bob_ws.send_json_to({
            "op": "voice_mute_update", "muted": False, "deafened": True,
        })
        await self._receive_until(bob_ws, "voice_mute_update")

        await alice_ws.send_json_to({"op": "voice_wake_user", "target_user_id": self.bob.id})
        seen = await self._receive_until(bob_ws, "voice_wake_requested")
        self.assertEqual(seen["from_user_id"], self.alice.id)

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_wake_user_ignored_when_target_not_muted_or_deafened(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        await self._join_and_drain(bob_ws, self.voice_channel.id)

        await alice_ws.send_json_to({"op": "voice_wake_user", "target_user_id": self.bob.id})
        await self._assert_op_not_received(bob_ws, "voice_wake_requested")

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_wake_user_ignored_when_not_in_same_channel(self):
        other_channel = await database_sync_to_async(Channel.objects.create)(
            server=self.server, name="v2", kind=Channel.VOICE, position=1)
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        await self._join_and_drain(alice_ws, self.voice_channel.id)
        await self._join_and_drain(bob_ws, other_channel.id)
        await bob_ws.send_json_to({
            "op": "voice_mute_update", "muted": True, "deafened": False,
        })
        await self._receive_until(bob_ws, "voice_mute_update")

        await alice_ws.send_json_to({"op": "voice_wake_user", "target_user_id": self.bob.id})
        await self._assert_op_not_received(bob_ws, "voice_wake_requested")

        await alice_ws.disconnect()
        await bob_ws.disconnect()


class SingleDeviceVoiceTests(TransactionTestCase):
    """Один аккаунт — один голосовой звонок одновременно, будь то канал
    сервера или диалог/группа (см. chat.consumers._kick_other_devices)."""

    def setUp(self):
        presence._r.flushdb()
        self.alice = User.objects.create_user(username="alice3", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.alice)
        Membership.objects.create(user=self.alice, server=self.server)
        self.voice_channel = Channel.objects.create(
            server=self.server, name="v", kind=Channel.VOICE, position=0)
        self.voice_channel2 = Channel.objects.create(
            server=self.server, name="v2", kind=Channel.VOICE, position=1)

    def tearDown(self):
        presence._r.flushdb()

    async def _connect(self, user, device_id=None):
        token = str(AccessToken.for_user(user))
        qs = f"token={token}"
        if device_id:
            qs += f"&device_id={device_id}"
        comm = WebsocketCommunicator(
            JWTAuthMiddleware(GatewayConsumer.as_asgi()),
            f"/ws/gateway?{qs}")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    @staticmethod
    async def _receive_until(comm, op, timeout=2, max_messages=15):
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            if msg.get("op") == op:
                return msg
        raise AssertionError(f"op={op!r} не пришёл за {max_messages} сообщений")

    @staticmethod
    async def _assert_op_not_received(comm, op, timeout=0.3):
        """Не должно прилететь СЕБЕ — самоподавление по connection_id
        (см. GatewayConsumer.broadcast).

        Опрашивает comm.output_queue НАПРЯМУЮ, а не через
        comm.receive_json_from: та на таймауте (штатный для неё способ
        сказать "больше ничего нет") ОТМЕНЯЕТ asgi-таск приложения — на
        одиночный "подожди и убедись, что ничего не пришло" внутри ещё
        живого теста это ломает дальнейшую работу с тем же соединением
        (следующий receive/disconnect падает CancelledError, см.
        asgiref.testing.ApplicationCommunicator.receive_output)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if comm.output_queue.empty():
                await asyncio.sleep(0.02)
                continue
            message = comm.output_queue.get_nowait()
            text = message.get("text")
            if text and json.loads(text).get("op") == op:
                raise AssertionError(f"неожиданно получили свой же {op!r}")

    async def test_second_device_same_channel_kicks_first(self):
        # Оба подключения — ОДИН и тот же аккаунт (два устройства/вкладки).
        device1 = await self._connect(self.alice)
        device2 = await self._connect(self.alice)

        await device1.send_json_to({"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(device1, "voice_peers")

        await device2.send_json_to({"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(device2, "voice_peers")

        # device1 обязан получить команду разорвать голос локально...
        await self._receive_until(device1, "voice_kicked_other_device")
        # ...а device2 (инициатор) — точно не должен получить его сам себе.
        await self._assert_op_not_received(device2, "voice_kicked_other_device")

        await device1.disconnect()
        await device2.disconnect()

    async def test_same_device_id_does_not_self_kick(self):
        """Реальный баг, отловленный вручную: React StrictMode в деве на миг
        держит ДВА живых WS для одной вкладки (mount -> cleanup -> remount),
        и с чисто случайным per-соединение id это выглядело как "другое
        устройство" — voice_join с новой попытки кикал уже идущий звонок той
        же вкладки. device_id в query стабилен для вкладки (см. gateway.tsx,
        sessionStorage) — два соединения с ОДНИМ И ТЕМ ЖЕ device_id обязаны
        считаться собой, а не отдельными устройствами."""
        same_id = "tab-abc123"
        conn1 = await self._connect(self.alice, device_id=same_id)
        conn2 = await self._connect(self.alice, device_id=same_id)

        await conn1.send_json_to({"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(conn1, "voice_peers")

        await conn2.send_json_to({"op": "voice_join", "channel_id": self.voice_channel2.id})
        await self._receive_until(conn2, "voice_peers")

        # Тот же device_id — conn1 НЕ должен получить "тебя кикнули".
        await self._assert_op_not_received(conn1, "voice_kicked_other_device")

        await conn1.disconnect()
        await conn2.disconnect()

    async def test_second_device_dm_call_kicks_first_channel_call(self):
        """Ровно требование из ревью: нельзя "с телефона в канал" и "с
        компа в личку" одновременно — проверяем именно разные типы комнат."""
        other = await database_sync_to_async(User.objects.create_user)(
            username="bob3", password="pw12345")
        conversation = await database_sync_to_async(Conversation.objects.create)(
            kind=Conversation.DM)
        await database_sync_to_async(ConversationParticipant.objects.create)(
            conversation=conversation, user=self.alice)
        await database_sync_to_async(ConversationParticipant.objects.create)(
            conversation=conversation, user=other)

        phone = await self._connect(self.alice)
        pc = await self._connect(self.alice)

        await phone.send_json_to({"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(phone, "voice_peers")

        await pc.send_json_to({
            "op": "dm_voice_join", "conversation_id": conversation.id})
        await self._receive_until(pc, "dm_voice_peers")

        await self._receive_until(phone, "voice_kicked_other_device")

        # presence обязана указывать ровно на комнату диалога — "кик" не
        # должен был откатить/стереть только что установленный join.
        room = await database_sync_to_async(presence.voice_channel)(str(self.alice.id))
        self.assertEqual(room, dm_room(conversation.id))

        await phone.disconnect()
        await pc.disconnect()

    async def test_kicked_device_leave_does_not_clear_new_device_presence(self):
        """Старое устройство после кика не шлёт voice_leave (иначе стёрло бы
        presence нового) — фронт это соблюдает (AppShell.tsx), здесь же просто
        убеждаемся, что presence остаётся консистентной без него: раз
        voice_leave не пришёл, join второго устройства должен быть последним
        словом."""
        device1 = await self._connect(self.alice)
        device2 = await self._connect(self.alice)

        await device1.send_json_to({"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(device1, "voice_peers")
        await device2.send_json_to({"op": "voice_join", "channel_id": self.voice_channel2.id})
        await self._receive_until(device2, "voice_peers")
        await self._receive_until(device1, "voice_kicked_other_device")

        room = await database_sync_to_async(presence.voice_channel)(str(self.alice.id))
        self.assertEqual(room, str(self.voice_channel2.id))

        await device1.disconnect()
        await device2.disconnect()

    async def test_only_voice_device_leaving_clears_presence_even_with_other_tab_open(self):
        """Реальный баг: два таба одного аккаунта, голос активен только в
        одном. Закрыли ИМЕННО ЕГО, второй (без голоса) остался открытым —
        presence обязана посчитать голос покинутым сразу же, а не ждать, пока
        закроется и второй таб тоже (см. GatewayConsumer.disconnect,
        presence.is_voice_owner). Раньше disconnect() решал разослать "вышел
        из голоса" только когда у аккаунта не осталось НИ ОДНОГО живого
        WS-соединения — с открытым вторым табом голос молча "зависал" в
        presence навсегда."""
        voice_tab = await self._connect(self.alice)
        idle_tab = await self._connect(self.alice)

        await voice_tab.send_json_to(
            {"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(voice_tab, "voice_peers")
        # idle_tab — та же server-группа, поэтому сначала видит сам JOIN.
        joined = await self._receive_until(idle_tab, "voice_state_update")
        self.assertEqual(joined["channel_id"], self.voice_channel.id)

        await voice_tab.disconnect()

        left = await self._receive_until(idle_tab, "voice_state_update")
        self.assertEqual(left["user_id"], self.alice.id)
        self.assertIsNone(left["channel_id"])

        room = await database_sync_to_async(presence.voice_channel)(str(self.alice.id))
        self.assertIsNone(room)

        await idle_tab.disconnect()

    async def test_closing_idle_tab_does_not_clear_other_tabs_voice(self):
        """Симметричная проверка на переусердствование фикса выше: закрыли
        ВТОРОЙ (без голоса) таб — голос в первом должен остаться нетронутым."""
        voice_tab = await self._connect(self.alice)
        idle_tab = await self._connect(self.alice)

        await voice_tab.send_json_to(
            {"op": "voice_join", "channel_id": self.voice_channel.id})
        await self._receive_until(voice_tab, "voice_peers")

        await idle_tab.disconnect()

        room = await database_sync_to_async(presence.voice_channel)(str(self.alice.id))
        self.assertEqual(room, str(self.voice_channel.id))

        await voice_tab.disconnect()


class ChannelCreateBroadcastTests(TransactionTestCase):
    """POST /channels должен живьём разослать новый канал участникам сервера,
    а не только вернуть его в ответе создателю (иначе остальным нужно
    перезагружать страницу, чтобы увидеть новый канал)."""

    def setUp(self):
        presence._r.flushdb()
        self.alice = User.objects.create_user(username="alice3", password="pw12345")
        self.bob = User.objects.create_user(username="bob3", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.alice)
        for u in (self.alice, self.bob):
            Membership.objects.create(user=u, server=self.server)

    def tearDown(self):
        presence._r.flushdb()

    async def _connect(self, user):
        token = str(AccessToken.for_user(user))
        comm = WebsocketCommunicator(
            JWTAuthMiddleware(GatewayConsumer.as_asgi()),
            f"/ws/gateway?token={token}")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    @staticmethod
    async def _receive_until(comm, op, timeout=2, max_messages=10):
        """Пропускает "ready"/presence и т.п., пока не найдёт нужный op — как
        в GatewayVoiceSignalingTests, порядок broadcast vs direct send не
        гарантирован."""
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            if msg.get("op") == op:
                return msg
        raise AssertionError(f"op={op!r} не пришёл за {max_messages} сообщений")

    async def test_other_member_gets_new_channel_over_ws(self):
        bob_ws = await self._connect(self.bob)

        client = APIClient()
        client.force_authenticate(self.alice)
        resp = await sync_to_async(client.post)(
            f"/api/servers/{self.server.id}/channels",
            {"name": "новости", "kind": "text"},
        )
        self.assertEqual(resp.status_code, 201)

        msg = await self._receive_until(bob_ws, "channel_create")
        self.assertEqual(msg["server_id"], self.server.id)
        self.assertEqual(msg["channel"]["name"], "новости")
        self.assertEqual(msg["channel"]["kind"], "text")

        await bob_ws.disconnect()


class MessageOpsTests(TransactionTestCase):
    """Удалить своё сообщение может автор, чужое — только владелец сервера.
    Редактировать можно ТОЛЬКО своё — владелец сервера чужое не правит."""

    def setUp(self):
        presence._r.flushdb()
        self.owner = User.objects.create_user(username="owner2", password="pw12345")
        self.member = User.objects.create_user(username="member2", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        for u in (self.owner, self.member):
            Membership.objects.create(user=u, server=self.server)
        self.channel = Channel.objects.create(
            server=self.server, name="general", kind=Channel.TEXT, position=0)

    def tearDown(self):
        presence._r.flushdb()

    async def _connect(self, user):
        token = str(AccessToken.for_user(user))
        comm = WebsocketCommunicator(
            JWTAuthMiddleware(GatewayConsumer.as_asgi()),
            f"/ws/gateway?token={token}")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    @staticmethod
    async def _receive_until(comm, op, timeout=2, max_messages=10):
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            if msg.get("op") == op:
                return msg
        raise AssertionError(f"op={op!r} не пришёл за {max_messages} сообщений")

    async def _send(self, comm, content, reply_to=None):
        await comm.send_json_to({
            "op": "send_message", "channel_id": self.channel.id,
            "content": content, "reply_to": reply_to,
        })
        msg = await self._receive_until(comm, "message_create")
        return msg["message"]

    async def test_author_can_delete_own_message(self):
        member_ws = await self._connect(self.member)
        owner_ws = await self._connect(self.owner)

        sent = await self._send(member_ws, "привет")
        await self._receive_until(owner_ws, "message_create")

        await member_ws.send_json_to({"op": "delete_message", "message_id": sent["id"]})
        seen = await self._receive_until(owner_ws, "message_delete")
        self.assertEqual(seen["message_id"], sent["id"])
        self.assertEqual(seen["channel_id"], self.channel.id)
        exists = await sync_to_async(Message.objects.filter(id=sent["id"]).exists)()
        self.assertFalse(exists)

        await member_ws.disconnect()
        await owner_ws.disconnect()

    async def test_owner_can_delete_others_message(self):
        member_ws = await self._connect(self.member)
        owner_ws = await self._connect(self.owner)

        sent = await self._send(member_ws, "привет")
        await self._receive_until(owner_ws, "message_create")

        await owner_ws.send_json_to({"op": "delete_message", "message_id": sent["id"]})
        seen = await self._receive_until(member_ws, "message_delete")
        self.assertEqual(seen["message_id"], sent["id"])

        await member_ws.disconnect()
        await owner_ws.disconnect()

    async def test_regular_member_cannot_delete_others_message(self):
        owner_ws = await self._connect(self.owner)
        member_ws = await self._connect(self.member)

        sent = await self._send(owner_ws, "привет от владельца")
        await self._receive_until(member_ws, "message_create")

        await member_ws.send_json_to({"op": "delete_message", "message_id": sent["id"]})
        self.assertTrue(await owner_ws.receive_nothing(timeout=0.3))
        exists = await sync_to_async(Message.objects.filter(id=sent["id"]).exists)()
        self.assertTrue(exists)

        await owner_ws.disconnect()
        await member_ws.disconnect()

    async def test_author_can_edit_own_message(self):
        member_ws = await self._connect(self.member)
        owner_ws = await self._connect(self.owner)

        sent = await self._send(member_ws, "опечатко")
        await self._receive_until(owner_ws, "message_create")

        await member_ws.send_json_to({
            "op": "edit_message", "message_id": sent["id"], "content": "исправлено",
        })
        seen = await self._receive_until(owner_ws, "message_update")
        self.assertEqual(seen["message"]["content"], "исправлено")
        self.assertIsNotNone(seen["message"]["edited_at"])

        await member_ws.disconnect()
        await owner_ws.disconnect()

    async def test_owner_cannot_edit_others_message(self):
        member_ws = await self._connect(self.member)
        owner_ws = await self._connect(self.owner)

        sent = await self._send(member_ws, "оригинал")
        await self._receive_until(owner_ws, "message_create")

        await owner_ws.send_json_to({
            "op": "edit_message", "message_id": sent["id"], "content": "подделка",
        })
        self.assertTrue(await member_ws.receive_nothing(timeout=0.3))
        content = await sync_to_async(
            lambda: Message.objects.get(id=sent["id"]).content)()
        self.assertEqual(content, "оригинал")

        await member_ws.disconnect()
        await owner_ws.disconnect()

    async def test_reply_is_included_in_broadcast(self):
        owner_ws = await self._connect(self.owner)
        member_ws = await self._connect(self.member)

        original = await self._send(owner_ws, "вопрос")
        await self._receive_until(member_ws, "message_create")

        await member_ws.send_json_to({
            "op": "send_message", "channel_id": self.channel.id,
            "content": "ответ", "reply_to": original["id"],
        })
        seen = await self._receive_until(owner_ws, "message_create")
        self.assertEqual(seen["message"]["reply_to"]["id"], original["id"])
        self.assertEqual(seen["message"]["reply_to"]["content"], "вопрос")

        await owner_ws.disconnect()
        await member_ws.disconnect()

    async def test_owner_can_pin_and_unpin_message(self):
        member_ws = await self._connect(self.member)
        owner_ws = await self._connect(self.owner)

        sent = await self._send(member_ws, "важное")
        await self._receive_until(owner_ws, "message_create")

        await owner_ws.send_json_to({
            "op": "pin_message", "message_id": sent["id"], "pinned": True,
        })
        seen = await self._receive_until(member_ws, "message_update")
        self.assertTrue(seen["message"]["pinned"])

        await owner_ws.send_json_to({
            "op": "pin_message", "message_id": sent["id"], "pinned": False,
        })
        seen = await self._receive_until(member_ws, "message_update")
        self.assertFalse(seen["message"]["pinned"])
        pinned_at = await sync_to_async(
            lambda: Message.objects.get(id=sent["id"]).pinned_at)()
        self.assertIsNone(pinned_at)

        await member_ws.disconnect()
        await owner_ws.disconnect()

    async def test_regular_member_cannot_pin_even_own_message(self):
        """Закрепление — модерация канала, а не право автора на своё
        сообщение: рядовому участнику (без delete_messages) оно недоступно."""
        owner_ws = await self._connect(self.owner)
        member_ws = await self._connect(self.member)

        sent = await self._send(member_ws, "моё сообщение")
        await self._receive_until(owner_ws, "message_create")

        await member_ws.send_json_to({
            "op": "pin_message", "message_id": sent["id"], "pinned": True,
        })
        self.assertTrue(await owner_ws.receive_nothing(timeout=0.3))
        pinned_at = await sync_to_async(
            lambda: Message.objects.get(id=sent["id"]).pinned_at)()
        self.assertIsNone(pinned_at)

        await owner_ws.disconnect()
        await member_ws.disconnect()

    async def test_reply_to_message_in_other_channel_is_ignored(self):
        other_channel = await sync_to_async(Channel.objects.create)(
            server=self.server, name="other", kind=Channel.TEXT, position=1)
        foreign_msg = await sync_to_async(Message.objects.create)(
            channel=other_channel, author=self.owner, content="из другого канала")

        member_ws = await self._connect(self.member)
        sent = await self._send(member_ws, "попытка подмены", reply_to=foreign_msg.id)
        self.assertIsNone(sent["reply_to"])

        await member_ws.disconnect()


class RoleHierarchyTests(APITestCase):
    """Иерархия ролей — защита от эскалации привилегий через manage_roles.

    Без неё участник с одним лишь правом «управлять ролями» мог создать роль
    с manage_server/manage_members и выдать её себе, то есть стать фактическим
    владельцем сервера.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="rh_owner", password="pw12345")
        self.mod = User.objects.create_user(username="rh_mod", password="pw12345")
        self.plain = User.objects.create_user(username="rh_plain", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        self.mod_membership = Membership.objects.create(user=self.mod, server=self.server)
        self.plain_membership = Membership.objects.create(
            user=self.plain, server=self.server)
        roles.create_default_role(self.server)
        # Модератор: умеет управлять ролями и участниками, но не сервером.
        self.mod_role = Role.objects.create(
            server=self.server, name="модер", position=5,
            manage_roles=True, manage_members=True)
        self.mod_membership.roles.add(self.mod_role)
        self.client.force_authenticate(self.mod)

    def test_cannot_create_role_with_permission_it_lacks(self):
        resp = self.client.post(
            f"/api/servers/{self.server.id}/roles",
            {"name": "суперроль", "position": 1, "manage_server": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(Role.objects.filter(name="суперроль").exists())

    def test_can_create_role_within_own_permissions(self):
        resp = self.client.post(
            f"/api/servers/{self.server.id}/roles",
            {"name": "помощник", "position": 1, "manage_members": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 201)

    def test_cannot_create_role_at_or_above_own_position(self):
        resp = self.client.post(
            f"/api/servers/{self.server.id}/roles",
            {"name": "равная", "position": 5},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_cannot_edit_own_role(self):
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{self.mod_role.id}",
            {"manage_server": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        self.mod_role.refresh_from_db()
        self.assertFalse(self.mod_role.manage_server)

    def test_cannot_grant_role_at_or_above_own_position(self):
        high = Role.objects.create(server=self.server, name="админ", position=9)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/members/{self.plain.id}",
            {"role_ids": [high.id]},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(self.plain_membership.roles.count(), 0)

    def test_cannot_kick_or_ban_peer_of_same_rank(self):
        peer = User.objects.create_user(username="rh_peer", password="pw12345")
        peer_membership = Membership.objects.create(user=peer, server=self.server)
        peer_membership.roles.add(self.mod_role)

        self.assertEqual(
            self.client.delete(
                f"/api/servers/{self.server.id}/members/{peer.id}").status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f"/api/servers/{self.server.id}/bans",
                {"user_id": peer.id}, format="json",
            ).status_code,
            403,
        )
        self.assertTrue(
            Membership.objects.filter(user=peer, server=self.server).exists())

    def test_can_act_on_lower_ranked_member(self):
        resp = self.client.delete(
            f"/api/servers/{self.server.id}/members/{self.plain.id}")
        self.assertEqual(resp.status_code, 204)

    def test_owner_bypasses_hierarchy(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{self.mod_role.id}",
            {"manage_server": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)


class VoicePermissionTests(APITestCase):
    """Права speak/view_channels теперь действительно проверяются: до этого
    роль могла их снять, а участник всё равно получал голосовой токен."""

    def setUp(self):
        self.owner = User.objects.create_user(username="vp_owner", password="pw12345")
        self.member = User.objects.create_user(username="vp_member", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)
        self.default_role = roles.create_default_role(self.server)
        self.voice = Channel.objects.create(
            server=self.server, name="General", kind=Channel.VOICE)
        self.text = Channel.objects.create(
            server=self.server, name="general", kind=Channel.TEXT)
        self.client.force_authenticate(self.member)

    def test_voice_credentials_denied_without_speak(self):
        self.default_role.speak = False
        self.default_role.save(update_fields=["speak"])
        resp = self.client.post(f"/api/channels/{self.voice.id}/voice-credentials")
        self.assertEqual(resp.status_code, 403)

    def test_voice_credentials_allowed_with_speak(self):
        resp = self.client.post(f"/api/channels/{self.voice.id}/voice-credentials")
        self.assertEqual(resp.status_code, 200)

    def test_token_carries_role_permissions(self):
        self.default_role.video = False
        self.default_role.save(update_fields=["video"])
        resp = self.client.post(f"/api/channels/{self.voice.id}/voice-credentials")
        self.assertEqual(resp.status_code, 200)
        claims = jwt.decode(
            resp.data["sfu_token"], settings.SFU_SECRET, algorithms=["HS256"])
        self.assertTrue(claims["speak"])
        self.assertFalse(claims["video"])

    def test_messages_denied_without_view_channels(self):
        self.default_role.view_channels = False
        self.default_role.save(update_fields=["view_channels"])
        resp = self.client.get(f"/api/channels/{self.text.id}/messages")
        self.assertEqual(resp.status_code, 403)


class ConversationAccessTests(APITestCase):
    """Создание бесед. Ветка group раньше не проверяла НИЧЕГО — настройка
    dm_privacy обходилась подстановкой kind=group вместо kind=dm."""

    def setUp(self):
        self.me = User.objects.create_user(username="ca_me", password="pw12345")
        self.closed = User.objects.create_user(
            username="ca_closed", password="pw12345", dm_privacy=User.DM_NOBODY)
        self.open_user = User.objects.create_user(
            username="ca_open", password="pw12345", dm_privacy=User.DM_EVERYONE)
        self.client.force_authenticate(self.me)

    def test_dm_to_closed_user_rejected(self):
        resp = self.client.post(
            "/api/conversations",
            {"kind": "dm", "user_ids": [self.closed.id]}, format="json")
        self.assertEqual(resp.status_code, 403)

    def test_group_cannot_bypass_dm_privacy(self):
        """Тот же человек, тот же запрет — только через kind=group."""
        resp = self.client.post(
            "/api/conversations",
            {"kind": "group", "user_ids": [self.closed.id]}, format="json")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(Conversation.objects.count(), 0)

    def test_group_with_allowed_user_ok(self):
        resp = self.client.post(
            "/api/conversations",
            {"kind": "group", "user_ids": [self.open_user.id], "name": "тусовка"},
            format="json")
        self.assertEqual(resp.status_code, 201)

    def test_nonexistent_user_id_gives_400_not_500(self):
        resp = self.client.post(
            "/api/conversations",
            {"kind": "group", "user_ids": [self.open_user.id, 10_000_000]},
            format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Conversation.objects.count(), 0)

    def test_participant_limit_enforced(self):
        resp = self.client.post(
            "/api/conversations",
            {"kind": "group", "user_ids": list(range(1, 200))}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_dm_is_deduplicated_by_key(self):
        first = self.client.post(
            "/api/conversations",
            {"kind": "dm", "user_ids": [self.open_user.id]}, format="json")
        second = self.client.post(
            "/api/conversations",
            {"kind": "dm", "user_ids": [self.open_user.id]}, format="json")
        self.assertEqual(first.data["id"], second.data["id"])
        self.assertEqual(Conversation.objects.filter(kind="dm").count(), 1)

    def test_dm_key_unique_constraint_blocks_duplicate(self):
        """Индекс, а не только проверка в коде: гонку двух одновременных
        запросов на уровне приложения не поймать."""
        key = Conversation.build_dm_key(self.me.id, self.open_user.id)
        Conversation.objects.create(kind=Conversation.DM, dm_key=key)
        with self.assertRaises(IntegrityError):
            Conversation.objects.create(kind=Conversation.DM, dm_key=key)

    def test_leave_conversation(self):
        created = self.client.post(
            "/api/conversations",
            {"kind": "group", "user_ids": [self.open_user.id]}, format="json")
        conversation_id = created.data["id"]
        resp = self.client.delete(f"/api/conversations/{conversation_id}")
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(
            ConversationParticipant.objects.filter(
                conversation_id=conversation_id, user=self.me).exists())

    def test_leave_requires_participation(self):
        conversation = Conversation.objects.create(kind=Conversation.GROUP)
        ConversationParticipant.objects.create(
            conversation=conversation, user=self.open_user)
        resp = self.client.delete(f"/api/conversations/{conversation.id}")
        self.assertEqual(resp.status_code, 403)


class MessagePaginationTests(APITestCase):
    """Курсорная пагинация: раньше ручка жёстко отдавала последние 50
    сообщений без курсора, и всё, что старше, было недостижимо в принципе."""

    def setUp(self):
        self.user = User.objects.create_user(username="mp_user", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.user)
        Membership.objects.create(user=self.user, server=self.server)
        roles.create_default_role(self.server)
        self.channel = Channel.objects.create(
            server=self.server, name="general", kind=Channel.TEXT)
        self.messages = [
            Message.objects.create(
                channel=self.channel, author=self.user, content=f"msg {i}")
            for i in range(120)
        ]
        self.client.force_authenticate(self.user)

    def test_default_page_is_latest_50_in_chronological_order(self):
        resp = self.client.get(f"/api/channels/{self.channel.id}/messages")
        self.assertEqual(len(resp.data), 50)
        self.assertEqual(resp.data[-1]["content"], "msg 119")
        self.assertEqual(resp.data[0]["content"], "msg 70")

    def test_before_cursor_reaches_older_history(self):
        oldest_on_first_page = self.messages[70].id
        resp = self.client.get(
            f"/api/channels/{self.channel.id}/messages?before={oldest_on_first_page}")
        self.assertEqual(len(resp.data), 50)
        self.assertEqual(resp.data[-1]["content"], "msg 69")

    def test_after_cursor_backfills_missed_messages(self):
        resp = self.client.get(
            f"/api/channels/{self.channel.id}/messages?after={self.messages[117].id}")
        self.assertEqual([m["content"] for m in resp.data], ["msg 118", "msg 119"])

    def test_limit_is_capped(self):
        resp = self.client.get(f"/api/channels/{self.channel.id}/messages?limit=9999")
        self.assertEqual(len(resp.data), 100)

    def test_garbage_cursor_is_ignored_not_fatal(self):
        resp = self.client.get(
            f"/api/channels/{self.channel.id}/messages?before=nonsense")
        self.assertEqual(resp.status_code, 200)


class ChannelPinsTests(APITestCase):
    """Закреплённые отдаются отдельной ручкой: в постраничную ленту старое
    закреплённое сообщение просто не попадает (см. MessagePaginationTests)."""

    def setUp(self):
        self.user = User.objects.create_user(username="pin_user", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.user)
        Membership.objects.create(user=self.user, server=self.server)
        roles.create_default_role(self.server)
        self.channel = Channel.objects.create(
            server=self.server, name="general", kind=Channel.TEXT)
        self.messages = [
            Message.objects.create(
                channel=self.channel, author=self.user, content=f"msg {i}")
            for i in range(3)
        ]
        self.client.force_authenticate(self.user)

    def test_empty_by_default(self):
        resp = self.client.get(f"/api/channels/{self.channel.id}/pins")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data, [])

    def test_latest_pinned_first_regardless_of_message_age(self):
        # Закрепляем СНАЧАЛА свежее, потом старое — порядок должен быть по
        # моменту закрепления, а не по дате самих сообщений.
        self.messages[2].pinned_at = timezone.now()
        self.messages[2].save(update_fields=["pinned_at"])
        self.messages[0].pinned_at = timezone.now() + timedelta(seconds=1)
        self.messages[0].save(update_fields=["pinned_at"])

        resp = self.client.get(f"/api/channels/{self.channel.id}/pins")
        self.assertEqual([m["content"] for m in resp.data], ["msg 0", "msg 2"])
        self.assertTrue(all(m["pinned"] for m in resp.data))

    def test_non_member_cannot_read_pins(self):
        outsider = User.objects.create_user(username="pin_out", password="pw12345")
        self.client.force_authenticate(outsider)
        resp = self.client.get(f"/api/channels/{self.channel.id}/pins")
        self.assertEqual(resp.status_code, 403)


class PublicProfileSerializerTests(APITestCase):
    """Тяжёлый баннер и личная настройка приватности больше не едут в каждом
    сообщении и в каждой строке ростера."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="pp_user", password="pw12345",
            banner_image="data:image/gif;base64,AAAA", dm_privacy=User.DM_NOBODY)
        self.server = Server.objects.create(name="s", owner=self.user)
        Membership.objects.create(user=self.user, server=self.server)
        roles.create_default_role(self.server)
        self.client.force_authenticate(self.user)

    def test_roster_omits_banner_and_privacy(self):
        resp = self.client.get(f"/api/servers/{self.server.id}/members")
        entry = resp.data[0]
        self.assertNotIn("banner_image", entry)
        self.assertNotIn("dm_privacy", entry)
        self.assertIn("avatar_image", entry)

    def test_me_still_returns_full_profile(self):
        resp = self.client.get("/api/auth/me")
        self.assertIn("banner_image", resp.data)
        self.assertIn("dm_privacy", resp.data)

    def test_profile_card_endpoint_serves_banner(self):
        resp = self.client.get(f"/api/users/{self.user.id}/profile-card")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["banner_image"], "data:image/gif;base64,AAAA")

    def test_profile_card_denied_to_stranger(self):
        stranger = User.objects.create_user(username="pp_stranger", password="pw12345")
        self.client.force_authenticate(stranger)
        resp = self.client.get(f"/api/users/{self.user.id}/profile-card")
        self.assertEqual(resp.status_code, 403)

    def test_profile_card_includes_pronouns_status_and_joined(self):
        self.user.pronouns = "they/them"
        self.user.custom_status = "варю кофе"
        self.user.custom_status_emoji = "☕"
        self.user.save()
        resp = self.client.get(f"/api/users/{self.user.id}/profile-card")
        self.assertEqual(resp.data["pronouns"], "they/them")
        self.assertEqual(resp.data["custom_status"], "варю кофе")
        self.assertEqual(resp.data["custom_status_emoji"], "☕")
        self.assertIn("date_joined", resp.data)


class ConversationSettingsTests(APITestCase):
    """Закрепление и «закрытие» диалога — личные настройки участия
    (см. chat.models.ConversationParticipant)."""

    def setUp(self):
        self.me = User.objects.create_user(username="conv_me", password="pw12345")
        self.peer = User.objects.create_user(username="conv_peer", password="pw12345")
        self.conversation = Conversation.objects.create(kind=Conversation.DM)
        for u in (self.me, self.peer):
            ConversationParticipant.objects.create(conversation=self.conversation, user=u)
        self.client.force_authenticate(self.me)

    def test_pin_roundtrip_and_visible_in_list(self):
        resp = self.client.patch(
            f"/api/conversations/{self.conversation.id}/settings",
            {"pinned": True}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.data["pinned"])
        listing = self.client.get("/api/conversations")
        self.assertTrue(listing.data[0]["pinned"])

    def test_pin_is_personal(self):
        self.client.patch(
            f"/api/conversations/{self.conversation.id}/settings",
            {"pinned": True}, format="json")
        self.client.force_authenticate(self.peer)
        listing = self.client.get("/api/conversations")
        self.assertFalse(listing.data[0]["pinned"])

    def test_closed_hides_from_list_but_keeps_membership(self):
        self.client.patch(
            f"/api/conversations/{self.conversation.id}/settings",
            {"closed": True}, format="json")
        self.assertEqual(self.client.get("/api/conversations").data, [])
        # Участие и история на месте — «закрыть» это не «выйти».
        self.assertTrue(ConversationParticipant.objects.filter(
            conversation=self.conversation, user=self.me).exists())
        # Сообщения по-прежнему доступны, если открыть диалог напрямую.
        self.assertEqual(
            self.client.get(f"/api/conversations/{self.conversation.id}/messages").status_code,
            200)

    def test_non_participant_cannot_change_settings(self):
        stranger = User.objects.create_user(username="conv_stranger", password="pw12345")
        self.client.force_authenticate(stranger)
        resp = self.client.patch(
            f"/api/conversations/{self.conversation.id}/settings",
            {"pinned": True}, format="json")
        self.assertEqual(resp.status_code, 403)


class UserRelationTests(APITestCase):
    """Игнор и блокировка — личные, односторонние (см. UserRelationState)."""

    def setUp(self):
        self.me = User.objects.create_user(username="rel_me", password="pw12345")
        self.peer = User.objects.create_user(username="rel_peer", password="pw12345")
        self.client.force_authenticate(self.me)

    def test_defaults_are_off(self):
        resp = self.client.get(f"/api/users/{self.peer.id}/relation")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.data["ignored"])
        self.assertFalse(resp.data["blocked"])

    def test_set_and_list(self):
        self.client.put(
            f"/api/users/{self.peer.id}/relation", {"blocked": True}, format="json")
        self.assertTrue(
            self.client.get(f"/api/users/{self.peer.id}/relation").data["blocked"])
        listing = self.client.get("/api/relations")
        self.assertEqual(len(listing.data), 1)
        self.assertEqual(listing.data[0]["user_id"], self.peer.id)

    def test_cannot_block_self(self):
        resp = self.client.put(
            f"/api/users/{self.me.id}/relation", {"blocked": True}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_relation_is_one_sided(self):
        self.client.put(
            f"/api/users/{self.peer.id}/relation", {"blocked": True}, format="json")
        self.client.force_authenticate(self.peer)
        # Заблокированный ничего об этом не знает: у него своё отношение пустое.
        self.assertFalse(
            self.client.get(f"/api/users/{self.me.id}/relation").data["blocked"])
        self.assertEqual(self.client.get("/api/relations").data, [])

    def test_blocked_author_messages_hidden_in_channel(self):
        server = Server.objects.create(name="s", owner=self.me)
        Membership.objects.create(user=self.me, server=server)
        Membership.objects.create(user=self.peer, server=server)
        channel = Channel.objects.create(server=server, name="general", kind=Channel.TEXT)
        Message.objects.create(channel=channel, author=self.peer, content="от заблокированного")
        Message.objects.create(channel=channel, author=self.me, content="моё")

        before = self.client.get(f"/api/channels/{channel.id}/messages")
        self.assertEqual(len(before.data), 2)

        self.client.put(
            f"/api/users/{self.peer.id}/relation", {"blocked": True}, format="json")
        after = self.client.get(f"/api/channels/{channel.id}/messages")
        self.assertEqual([m["content"] for m in after.data], ["моё"])

    def test_blocked_user_cannot_start_dm(self):
        # Блокировка сильнее «пишут все».
        self.me.dm_privacy = self.me.DM_EVERYONE
        self.me.save(update_fields=["dm_privacy"])
        self.client.put(
            f"/api/users/{self.peer.id}/relation", {"blocked": True}, format="json")
        self.client.force_authenticate(self.peer)
        resp = self.client.post(
            "/api/conversations",
            {"kind": "dm", "user_ids": [self.me.id]}, format="json")
        self.assertEqual(resp.status_code, 403)


class AvatarAnimationTests(APITestCase):
    """Гифка анимированного аватара — отдельной ручкой, по требованию (в
    самом профиле только флаг avatar_animated, см. accounts.serializers)."""

    GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

    def setUp(self):
        self.me = User.objects.create_user(username="anim_me", password="pw12345")
        self.other = User.objects.create_user(username="anim_other", password="pw12345")
        self.client.force_authenticate(self.me)

    def test_empty_when_avatar_is_not_animated(self):
        resp = self.client.get(f"/api/users/{self.other.id}/avatar-anim")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["avatar_anim"], "")

    def test_returns_gif_and_download_preference(self):
        self.other.avatar_anim = self.GIF
        self.other.avatar_downloadable = False
        self.other.save(update_fields=["avatar_anim", "avatar_downloadable"])
        resp = self.client.get(f"/api/users/{self.other.id}/avatar-anim")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["avatar_anim"], self.GIF)
        self.assertFalse(resp.data["downloadable"])

    def test_requires_authentication(self):
        self.client.force_authenticate(None)
        resp = self.client.get(f"/api/users/{self.other.id}/avatar-anim")
        self.assertEqual(resp.status_code, 401)


class ProfileNoteTests(APITestCase):
    """Приватная заметка о другом пользователе — своя у каждого
    просматривающего, виден только автору."""

    def setUp(self):
        self.author = User.objects.create_user(username="note_author", password="pw12345")
        self.about = User.objects.create_user(username="note_about", password="pw12345")
        # Общий сервер — та же видимость, что и у profile-card (см.
        # _can_see_profile), проще, чем заводить дружбу.
        self.server = Server.objects.create(name="s", owner=self.author)
        Membership.objects.create(user=self.author, server=self.server)
        Membership.objects.create(user=self.about, server=self.server)
        self.client.force_authenticate(self.author)

    def test_note_empty_by_default(self):
        resp = self.client.get(f"/api/users/{self.about.id}/note")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["text"], "")

    def test_create_and_read_note(self):
        put_resp = self.client.put(
            f"/api/users/{self.about.id}/note", {"text": "любит чай"},
            format="json")
        self.assertEqual(put_resp.status_code, 200)
        self.assertEqual(put_resp.data["text"], "любит чай")
        get_resp = self.client.get(f"/api/users/{self.about.id}/note")
        self.assertEqual(get_resp.data["text"], "любит чай")

    def test_note_overwrites_not_duplicates(self):
        self.client.put(f"/api/users/{self.about.id}/note", {"text": "a"}, format="json")
        self.client.put(f"/api/users/{self.about.id}/note", {"text": "b"}, format="json")
        self.assertEqual(ProfileNote.objects.filter(author=self.author, about=self.about).count(), 1)
        resp = self.client.get(f"/api/users/{self.about.id}/note")
        self.assertEqual(resp.data["text"], "b")

    def test_note_is_private_to_author(self):
        ProfileNote.objects.create(author=self.author, about=self.about, text="секрет")
        other = User.objects.create_user(username="note_other", password="pw12345")
        Membership.objects.create(user=other, server=self.server)
        self.client.force_authenticate(other)
        resp = self.client.get(f"/api/users/{self.about.id}/note")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["text"], "")  # своей заметки у other ещё нет

    def test_note_denied_to_stranger(self):
        stranger = User.objects.create_user(username="note_stranger", password="pw12345")
        self.client.force_authenticate(stranger)
        resp = self.client.get(f"/api/users/{self.about.id}/note")
        self.assertEqual(resp.status_code, 403)
        resp = self.client.put(f"/api/users/{self.about.id}/note", {"text": "x"}, format="json")
        self.assertEqual(resp.status_code, 403)


class FriendNicknameTests(APITestCase):
    """Приватный никнейм для другого человека (см. chat.models.FriendNickname)
    — как и заметка, односторонний и виден только тому, кто его поставил."""

    def setUp(self):
        self.owner = User.objects.create_user(username="nick_owner", password="pw12345")
        self.about = User.objects.create_user(username="nick_about", password="pw12345")
        # Общий сервер — тот же барьер видимости, что и у заметки/карточки
        # профиля (_can_see_profile), и заводится проще, чем дружба.
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.about, server=self.server)
        self.client.force_authenticate(self.owner)

    def test_empty_by_default(self):
        resp = self.client.get(f"/api/users/{self.about.id}/nickname")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["nickname"], "")

    def test_set_and_read(self):
        put_resp = self.client.put(
            f"/api/users/{self.about.id}/nickname", {"nickname": "Колян"}, format="json")
        self.assertEqual(put_resp.status_code, 200)
        self.assertEqual(put_resp.data["nickname"], "Колян")
        self.assertEqual(
            self.client.get(f"/api/users/{self.about.id}/nickname").data["nickname"], "Колян")

    def test_empty_value_removes_row_not_stores_blank(self):
        """Пустая строка снимает никнейм и НЕ оставляет за собой запись —
        иначе каждая пара, которую кто-то однажды тронул, копила бы мусор."""
        self.client.put(
            f"/api/users/{self.about.id}/nickname", {"nickname": "Колян"}, format="json")
        resp = self.client.put(
            f"/api/users/{self.about.id}/nickname", {"nickname": "  "}, format="json")
        self.assertEqual(resp.data["nickname"], "")
        self.assertFalse(
            FriendNickname.objects.filter(owner=self.owner, about=self.about).exists())

    def test_overwrites_not_duplicates(self):
        for value in ("a", "b"):
            self.client.put(
                f"/api/users/{self.about.id}/nickname", {"nickname": value}, format="json")
        self.assertEqual(
            FriendNickname.objects.filter(owner=self.owner, about=self.about).count(), 1)

    def test_private_to_owner(self):
        FriendNickname.objects.create(owner=self.owner, about=self.about, nickname="Колян")
        other = User.objects.create_user(username="nick_other", password="pw12345")
        Membership.objects.create(user=other, server=self.server)
        self.client.force_authenticate(other)
        self.assertEqual(
            self.client.get(f"/api/users/{self.about.id}/nickname").data["nickname"], "")

    def test_my_nicknames_lists_only_mine(self):
        FriendNickname.objects.create(owner=self.owner, about=self.about, nickname="Колян")
        stranger = User.objects.create_user(username="nick_stranger", password="pw12345")
        FriendNickname.objects.create(owner=stranger, about=self.about, nickname="Чужое")
        resp = self.client.get("/api/nicknames")
        self.assertEqual(resp.data, [{"user_id": self.about.id, "nickname": "Колян"}])

    def test_denied_to_stranger_and_to_self(self):
        stranger = User.objects.create_user(username="nick_stranger2", password="pw12345")
        self.client.force_authenticate(stranger)
        self.assertEqual(
            self.client.get(f"/api/users/{self.about.id}/nickname").status_code, 403)
        self.client.force_authenticate(self.owner)
        self.assertEqual(
            self.client.get(f"/api/users/{self.owner.id}/nickname").status_code, 400)


class PresenceEndpointTests(APITestCase):
    """GET /api/presence — статус друзей и собеседников (тех, у кого своего
    источника статуса нет: ростер сервера везёт его сам)."""

    def setUp(self):
        presence._r.flushdb()
        self.me = User.objects.create_user(username="pres_me", password="pw12345")
        self.friend = User.objects.create_user(username="pres_friend", password="pw12345")
        self.stranger = User.objects.create_user(username="pres_stranger", password="pw12345")
        Friendship.objects.create(
            from_user=self.me, to_user=self.friend, status=Friendship.ACCEPTED,
            responded_at=timezone.now())
        self.client.force_authenticate(self.me)

    def tearDown(self):
        presence._r.flushdb()

    def test_offline_friend_listed_as_offline(self):
        resp = self.client.get("/api/presence")
        self.assertEqual(resp.data, [{"user_id": self.friend.id, "status": "offline"}])

    def test_online_friend_and_no_strangers(self):
        presence.user_connected(self.friend.id)
        presence.user_connected(self.stranger.id)
        resp = self.client.get("/api/presence")
        self.assertEqual(resp.data, [{"user_id": self.friend.id, "status": "online"}])

    def test_invisible_friend_masked_as_offline(self):
        presence.user_connected(self.friend.id)
        self.friend.status = self.friend.INVISIBLE
        self.friend.save(update_fields=["status"])
        resp = self.client.get("/api/presence")
        self.assertEqual(resp.data, [{"user_id": self.friend.id, "status": "offline"}])

    def test_conversation_peer_without_friendship_included(self):
        peer = User.objects.create_user(username="pres_peer", password="pw12345")
        conversation = Conversation.objects.create(kind=Conversation.DM)
        for u in (self.me, peer):
            ConversationParticipant.objects.create(conversation=conversation, user=u)
        presence.user_connected(peer.id)
        ids = {row["user_id"] for row in self.client.get("/api/presence").data}
        self.assertEqual(ids, {self.friend.id, peer.id})


class FriendPresenceBroadcastTests(TransactionTestCase):
    """Presence друга долетает до него ЛИЧНО, даже когда общего сервера нет —
    иначе точке статуса в списке друзей неоткуда взяться (см.
    GatewayConsumer._broadcast_presence).

    TransactionTestCase по той же причине, что и GatewayVoiceSignalingTests.
    """

    def setUp(self):
        presence._r.flushdb()
        self.me = User.objects.create_user(username="bcast_me", password="pw12345")
        self.friend = User.objects.create_user(username="bcast_friend", password="pw12345")
        self.stranger = User.objects.create_user(username="bcast_stranger", password="pw12345")
        Friendship.objects.create(
            from_user=self.me, to_user=self.friend, status=Friendship.ACCEPTED,
            responded_at=timezone.now())

    def tearDown(self):
        presence._r.flushdb()

    async def _connect(self, user):
        token = str(AccessToken.for_user(user))
        comm = WebsocketCommunicator(
            JWTAuthMiddleware(GatewayConsumer.as_asgi()), f"/ws/gateway?token={token}")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    @staticmethod
    async def _assert_no_presence(comm, timeout=0.3):
        """Читает очередь НАПРЯМУЮ, без receive_json_from: тот при таймауте
        отменяет таск consumer'а, и следующий disconnect() падает на чужом
        event loop (тот же приём и по той же причине, что в
        GatewayVoiceSignalingTests._assert_op_not_received)."""
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            while not comm.output_queue.empty():
                raw = comm.output_queue.get_nowait()
                if "text" in raw:
                    msg = json.loads(raw["text"])
                    assert msg.get("op") != "presence_update", f"пришёл лишний {msg}"
            await asyncio.sleep(0.01)

    async def test_friend_receives_presence_without_shared_server(self):
        friend_ws = await self._connect(self.friend)
        stranger_ws = await self._connect(self.stranger)
        # "ready" своего же подключения — иначе оно "протечёт" в проверки ниже.
        # Своего presence ни тот, ни другой не получают: общих серверов у них
        # нет, а самому себе presence не адресуется.
        await friend_ws.receive_json_from(timeout=2)
        await stranger_ws.receive_json_from(timeout=2)

        me_ws = await self._connect(self.me)

        msg = await friend_ws.receive_json_from(timeout=2)
        self.assertEqual(msg["op"], "presence_update")
        self.assertEqual(msg["user_id"], self.me.id)
        self.assertEqual(msg["status"], "online")

        # Чужому — ничего: он мне не друг и не собеседник.
        await self._assert_no_presence(stranger_ws)

        await me_ws.disconnect()
        await friend_ws.disconnect()
        await stranger_ws.disconnect()

    async def test_presence_not_duplicated_for_friend_on_shared_server(self):
        """Друг, с которым мы ещё и на общем сервере, получает событие ОДИН
        раз: серверная рассылка и персональная не должны накладываться."""
        server = await database_sync_to_async(Server.objects.create)(
            name="s", owner=self.me)
        for user in (self.me, self.friend):
            await database_sync_to_async(Membership.objects.create)(
                user=user, server=server)

        friend_ws = await self._connect(self.friend)
        await friend_ws.receive_json_from(timeout=2)  # "ready"
        await friend_ws.receive_json_from(timeout=2)  # свой собственный presence

        me_ws = await self._connect(self.me)
        msg = await friend_ws.receive_json_from(timeout=2)
        self.assertEqual(msg["op"], "presence_update")
        self.assertEqual(msg["user_id"], self.me.id)
        await self._assert_no_presence(friend_ws)

        await me_ws.disconnect()
        await friend_ws.disconnect()


class HeartbeatSweepTests(TestCase):
    """Sweep призрачных presence-сессий: обе починки из код-ревью."""

    def setUp(self):
        from . import heartbeat_sweep

        self.sweep = heartbeat_sweep
        self.user = User.objects.create_user(username="hs_user", password="pw12345")
        self.other = User.objects.create_user(username="hs_other", password="pw12345")
        self.uid = str(self.user.id)
        presence.force_offline(self.uid)
        presence.force_offline(str(self.other.id))

    def tearDown(self):
        presence.force_offline(self.uid)
        presence.force_offline(str(self.other.id))

    def test_dm_room_does_not_raise(self):
        """Комната звонка в личке — строка "dm_<id>", а не число. Раньше она
        уходила прямо в Channel.objects.get(id=...), где целочисленное поле
        бросало ValueError (не DoesNotExist), он пролетал мимо except и рвал
        весь проход sweep'а."""
        conversation = Conversation.objects.create(kind=Conversation.DM)
        ConversationParticipant.objects.create(
            conversation=conversation, user=self.user)
        presence.user_connected(self.uid)
        presence.join_voice(self.uid, dm_room(conversation.id))

        layer = _FakeChannelLayer()
        self.sweep._force_disconnect_uid(self.uid, layer)

        self.assertFalse(presence.is_online(self.uid))
        groups = [group for group, _payload in layer.sent]
        self.assertIn(f"conversation_{conversation.id}", groups)
        dm_events = [
            payload for _group, payload in layer.sent
            if payload["op"] == "dm_voice_state_update"
        ]
        self.assertEqual(len(dm_events), 1)
        self.assertFalse(dm_events[0]["in_call"])

    def test_one_bad_uid_does_not_abort_whole_sweep(self):
        """Раньше исключение на одном пользователе срывало проход целиком, и
        остальные призраки оставались онлайн до следующей минуты."""
        presence.user_connected(self.uid)
        presence.user_connected(str(self.other.id))
        presence.clear_heartbeat(self.uid)
        presence.clear_heartbeat(str(self.other.id))

        original = self.sweep._force_disconnect_uid
        calls = []

        def flaky(uid, layer):
            calls.append(uid)
            if uid == self.uid:
                raise RuntimeError("сломалось на этом участнике")
            return original(uid, layer)

        self.sweep._force_disconnect_uid = flaky
        try:
            # assertLogs заодно глушит вывод в консоль — исключение здесь
            # бросается специально, и его трейсбек в прогоне только путает.
            with self.assertLogs("chat.heartbeat_sweep", level="ERROR") as logged:
                self.sweep._sweep_once()
        finally:
            self.sweep._force_disconnect_uid = original
        self.assertTrue(any("не удалось отключить" in line for line in logged.output))

        # Суть проверки: до второго участника проход ДОШЁЛ, хотя первый упал.
        # (Состояние в Redis тут не утверждаем: _sweep_once зовёт
        # close_old_connections(), а внутри TestCase это рвёт соединение,
        # обёрнутое в транзакцию теста, — к самому багу отношения не имеет.)
        self.assertEqual(len(calls), 2)
        self.assertIn(str(self.other.id), calls)

    def test_heartbeat_restores_user_wrongly_swept(self):
        """Пинг задержался дольше TTL, sweep счёл сокет призраком — но сокет
        жив. Раньше heartbeat трогал только TTL, и такой пользователь
        оставался офлайн для всех навсегда."""
        presence.user_connected(self.uid)
        self.assertTrue(presence.is_online(self.uid))

        presence.force_offline(self.uid)
        self.assertFalse(presence.is_online(self.uid))

        restored = presence.heartbeat(self.uid)
        self.assertTrue(restored)
        self.assertTrue(presence.is_online(self.uid))
        # Повторный пинг уже ничего не восстанавливает.
        self.assertFalse(presence.heartbeat(self.uid))


class MuteVoteClaimTests(TestCase):
    """Резолв голосования дёргают два независимых места (consumers и
    vote_sweep). Раньше read → tally → clear шли тремя операциями, и при
    совпадении по времени результат рассылался дважды."""

    def setUp(self):
        self.channel_id = "9911"
        presence.clear_mute_vote(self.channel_id)

    def tearDown(self):
        presence.clear_mute_vote(self.channel_id)

    def test_claim_returns_data_to_exactly_one_caller(self):
        presence.start_mute_vote(self.channel_id, 2, 1, 20)
        presence.cast_mute_vote(self.channel_id, 1, True)

        first_vote, first_for, _first_against = presence.claim_mute_vote(self.channel_id)
        second_vote, second_for, _second_against = presence.claim_mute_vote(
            self.channel_id)

        self.assertIsNotNone(first_vote)
        self.assertEqual(first_for, {"1"})
        self.assertIsNone(second_vote)
        self.assertEqual(second_for, set())

    def test_claim_clears_active_set(self):
        presence.start_mute_vote(self.channel_id, 2, 1, 20)
        self.assertIn(self.channel_id, presence.active_vote_channel_ids())
        presence.claim_mute_vote(self.channel_id)
        self.assertNotIn(self.channel_id, presence.active_vote_channel_ids())

    def test_resolve_twice_broadcasts_once(self):
        server_owner = User.objects.create_user(username="mvc_owner", password="pw12345")
        server = Server.objects.create(name="s", owner=server_owner)
        channel = Channel.objects.create(
            server=server, name="v", kind=Channel.VOICE)
        target = User.objects.create_user(username="mvc_target", password="pw12345")
        voter = User.objects.create_user(username="mvc_voter", password="pw12345")

        presence.clear_mute_vote(channel.id)
        presence.start_mute_vote(channel.id, target.id, voter.id, 20)
        presence.cast_mute_vote(channel.id, voter.id, True)

        layer = _FakeChannelLayer()
        mute_vote.resolve(channel.id, layer)
        mute_vote.resolve(channel.id, layer)

        results = [
            payload for _group, payload in layer.sent
            if payload["op"] == "voice_mute_vote_result"
        ]
        self.assertEqual(len(results), 1)
        presence.clear_forced_mute(target.id)


class AttachmentUploadTests(APITestCase):
    """Загрузка вложений: лимиты и — главное — определение типа по
    СОДЕРЖИМОМУ, а не по имени файла или заголовку запроса."""

    def setUp(self):
        self.user = User.objects.create_user(username="uploader", password="pw12345")
        self.client.force_authenticate(self.user)

    @staticmethod
    def _png_bytes(width=4, height=3):
        buffer = io.BytesIO()
        PILImage.new("RGB", (width, height), "red").save(buffer, format="PNG")
        return buffer.getvalue()

    def test_image_upload_detects_type_and_size(self):
        upload = SimpleUploadedFile(
            "картинка.png", self._png_bytes(8, 5), content_type="image/png")
        resp = self.client.post("/api/attachments", {"file": upload}, format="multipart")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.data["content_type"], "image/png")
        self.assertEqual(resp.data["width"], 8)
        self.assertEqual(resp.data["height"], 5)
        self.assertEqual(resp.data["original_name"], "картинка.png")
        self.assertTrue(resp.data["url"].startswith("/media/attachments/"))

    def test_html_disguised_as_image_is_not_served_as_image(self):
        """Файл с картиночным именем и заголовком, но HTML внутри, не должен
        получить встраиваемый content_type: иначе он открывался бы документом
        на нашем же origin — stored-XSS с доступом к токенам в localStorage."""
        upload = SimpleUploadedFile(
            "innocent.png",
            b"<html><script>alert(document.cookie)</script></html>",
            content_type="image/png",
        )
        resp = self.client.post("/api/attachments", {"file": upload}, format="multipart")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.data["content_type"], "application/octet-stream")

    def test_svg_is_never_embeddable(self):
        """SVG — это XML-документ, который браузер исполняет вместе с его
        <script>. Расширение честное, но встраивать такое нельзя."""
        upload = SimpleUploadedFile(
            "logo.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            content_type="image/svg+xml",
        )
        resp = self.client.post("/api/attachments", {"file": upload}, format="multipart")
        self.assertEqual(resp.data["content_type"], "application/octet-stream")

    def test_oversized_file_rejected(self):
        oversized = SimpleUploadedFile(
            "big.bin", b"\0" * (MAX_ATTACHMENT_BYTES + 1),
            content_type="application/octet-stream")
        resp = self.client.post("/api/attachments", {"file": oversized}, format="multipart")
        self.assertEqual(resp.status_code, 400)

    def test_empty_and_missing_file_rejected(self):
        self.assertEqual(
            self.client.post("/api/attachments", {}, format="multipart").status_code, 400)
        empty = SimpleUploadedFile("empty.txt", b"", content_type="text/plain")
        self.assertEqual(
            self.client.post(
                "/api/attachments", {"file": empty}, format="multipart").status_code,
            400,
        )

    def test_upload_requires_authentication(self):
        self.client.force_authenticate(None)
        upload = SimpleUploadedFile("a.png", self._png_bytes(), content_type="image/png")
        resp = self.client.post("/api/attachments", {"file": upload}, format="multipart")
        self.assertEqual(resp.status_code, 401)


class EmojiKeyTests(TestCase):
    """Реакцией может быть только эмодзи — иначе счётчик реакций
    превращается во второй чат из произвольных строк."""

    def test_plain_emoji_accepted(self):
        for key in ("🔥", "👍", "❤️", "🎉"):
            self.assertEqual(emoji_keys.normalize(key), key)

    def test_composite_emoji_accepted(self):
        # Составные последовательности: семья через ZWJ и клавишная кнопка.
        self.assertEqual(emoji_keys.normalize("👨‍👩‍👧"), "👨‍👩‍👧")
        self.assertEqual(emoji_keys.normalize("1️⃣"), "1️⃣")

    def test_text_rejected(self):
        for key in ("ХАХАХА", "lol", "привет мир", "12345", "", "   "):
            self.assertIsNone(emoji_keys.normalize(key))

    def test_emoji_with_text_rejected(self):
        # Символ эмодзи внутри есть, но это всё равно фраза, а не реакция.
        self.assertIsNone(emoji_keys.normalize("огонь🔥"))
        self.assertIsNone(emoji_keys.normalize("🔥 круто"))

    def test_overlong_and_wrong_types_rejected(self):
        self.assertIsNone(emoji_keys.normalize("🔥" * 40))
        self.assertIsNone(emoji_keys.normalize(None))
        self.assertIsNone(emoji_keys.normalize(42))

    def test_custom_emoji_key_rejected_while_feature_absent(self):
        # PLACEHOLDER-ветка: модели кастомных эмодзи ещё нет, поэтому ссылки
        # на них не принимаются — иначе копились бы реакции, которые нечем
        # отрисовать (см. chat/emoji.py).
        self.assertIsNone(emoji_keys.normalize("custom:42"))

    def test_every_emoji_offered_by_the_picker_is_accepted(self):
        """Каждый эмодзи из каталога фронта должен проходить валидацию здесь.

        Проверка через границу языков нужна потому, что расхождение тут
        абсолютно немое: пикер показывает символ, человек по нему кликает,
        сервер молча отклоняет ключ — и реакция просто не появляется, без
        единого сообщения об ошибке. Поймать это иначе можно только руками,
        перещёлкав все несколько сотен эмодзи.
        """
        catalog = (
            Path(settings.BASE_DIR).parent / "web" / "src" / "emoji.ts"
        ).read_text(encoding="utf-8")
        # Записи каталога имеют вид  e('😀', 'улыбка', ...)  — берём первый
        # аргумент, сам символ.
        chars = re.findall(r"^\s*e\('([^']+)'", catalog, re.MULTILINE)
        self.assertGreater(len(chars), 200, "каталог эмодзи не разобрался")

        rejected = [char for char in chars if emoji_keys.normalize(char) is None]
        self.assertEqual(rejected, [], f"пикер предлагает {len(rejected)} эмодзи, "
                                       "которые сервер не примет как реакцию")

    def test_quick_reactions_are_accepted(self):
        """Быстрые реакции из ховер-меню — тот же список, отдельной строкой:
        по ним кликают чаще всего."""
        catalog = (
            Path(settings.BASE_DIR).parent / "web" / "src" / "emoji.ts"
        ).read_text(encoding="utf-8")
        block = re.search(
            r"QUICK_REACTIONS = \[(.*?)\]", catalog, re.DOTALL).group(1)
        chars = re.findall(r"'([^']+)'", block)
        self.assertTrue(chars)
        for char in chars:
            self.assertIsNotNone(
                emoji_keys.normalize(char), f"быстрая реакция {char} отклоняется")


class ReactionAndDeliveryTests(TransactionTestCase):
    """Реакции, привязка вложений к сообщению и подтверждение доставки —
    всё через gateway, ровно так, как это делает настоящий клиент."""

    def setUp(self):
        presence._r.flushdb()
        self.owner = User.objects.create_user(username="rx_owner", password="pw12345")
        self.member = User.objects.create_user(username="rx_member", password="pw12345")
        self.outsider = User.objects.create_user(username="rx_out", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        for u in (self.owner, self.member):
            Membership.objects.create(user=u, server=self.server)
        self.channel = Channel.objects.create(
            server=self.server, name="general", kind=Channel.TEXT, position=0)

    def tearDown(self):
        presence._r.flushdb()

    async def _connect(self, user):
        token = str(AccessToken.for_user(user))
        comm = WebsocketCommunicator(
            JWTAuthMiddleware(GatewayConsumer.as_asgi()),
            f"/ws/gateway?token={token}")
        connected, _ = await comm.connect()
        self.assertTrue(connected)
        return comm

    @staticmethod
    async def _receive_until(comm, op, timeout=2, max_messages=10):
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            if msg.get("op") == op:
                return msg
        raise AssertionError(f"op={op!r} не пришёл за {max_messages} сообщений")

    async def _send(self, comm, content, **extra):
        await comm.send_json_to({
            "op": "send_message", "channel_id": self.channel.id,
            "content": content, **extra,
        })
        return await self._receive_until(comm, "message_create")

    # --- подтверждение доставки ---
    async def test_nonce_is_echoed_back_for_delivery_confirmation(self):
        ws = await self._connect(self.member)
        echo = await self._send(ws, "привет", nonce="n-1")
        self.assertEqual(echo["nonce"], "n-1")
        await ws.disconnect()

    async def test_retry_with_same_nonce_does_not_duplicate_message(self):
        """Ретрай — это повтор ТОЙ ЖЕ попытки: клиент не дождался эха и
        отправил снова. Без дедупликации по nonce в канале появлялось бы по
        два одинаковых сообщения на каждый мигнувший коннект."""
        ws = await self._connect(self.member)
        await self._send(ws, "дубль?", nonce="n-dup")

        await ws.send_json_to({
            "op": "send_message", "channel_id": self.channel.id,
            "content": "дубль?", "nonce": "n-dup",
        })
        ack = await self._receive_until(ws, "message_ack")
        self.assertEqual(ack["nonce"], "n-dup")

        count = await sync_to_async(
            Message.objects.filter(channel=self.channel).count)()
        self.assertEqual(count, 1)
        await ws.disconnect()

    async def test_send_without_access_is_nacked(self):
        """Раньше неудачная отправка молча ничего не делала, и сообщение
        навсегда висело бы в статусе «отправляется»."""
        ws = await self._connect(self.outsider)
        await ws.send_json_to({
            "op": "send_message", "channel_id": self.channel.id,
            "content": "меня тут нет", "nonce": "n-deny",
        })
        nack = await self._receive_until(ws, "message_nack")
        self.assertEqual(nack["nonce"], "n-deny")
        await ws.disconnect()

    async def test_empty_message_without_attachments_is_nacked(self):
        ws = await self._connect(self.member)
        await ws.send_json_to({
            "op": "send_message", "channel_id": self.channel.id,
            "content": "   ", "nonce": "n-empty",
        })
        nack = await self._receive_until(ws, "message_nack")
        self.assertEqual(nack["nonce"], "n-empty")
        await ws.disconnect()

    # --- вложения ---
    @database_sync_to_async
    def _make_attachment(self, user):
        buffer = io.BytesIO()
        PILImage.new("RGB", (2, 2), "blue").save(buffer, format="PNG")
        payload = buffer.getvalue()
        attachment = Attachment(
            uploaded_by=user, original_name="pic.png",
            content_type="image/png", size=len(payload), width=2, height=2)
        attachment.file.save(
            "pic.png", SimpleUploadedFile("pic.png", payload), save=False)
        attachment.save()
        return attachment

    async def test_attachment_is_bound_to_message(self):
        attachment = await self._make_attachment(self.member)
        ws = await self._connect(self.member)
        echo = await self._send(ws, "", attachment_ids=[str(attachment.id)])
        self.assertEqual(len(echo["message"]["attachments"]), 1)
        self.assertEqual(echo["message"]["attachments"][0]["original_name"], "pic.png")
        await ws.disconnect()

    async def test_message_with_only_attachment_is_allowed(self):
        """Картинка без подписи — нормальное сообщение; проверка «пусто»
        должна смотреть и на текст, и на вложения."""
        attachment = await self._make_attachment(self.member)
        ws = await self._connect(self.member)
        echo = await self._send(ws, "", attachment_ids=[str(attachment.id)])
        self.assertEqual(echo["message"]["content"], "")
        await ws.disconnect()

    async def test_cannot_attach_someone_elses_upload(self):
        """Иначе чужой файл прикреплялся бы к своему сообщению по одному лишь
        известному id."""
        foreign = await self._make_attachment(self.owner)
        ws = await self._connect(self.member)
        echo = await self._send(ws, "чужое", attachment_ids=[str(foreign.id)])
        self.assertEqual(echo["message"]["attachments"], [])
        await ws.disconnect()

    async def test_attachment_cannot_be_reused_in_second_message(self):
        """Один файл — одно сообщение: иначе вложение «переезжало» бы из
        старого сообщения в новое, исчезая из первого."""
        attachment = await self._make_attachment(self.member)
        ws = await self._connect(self.member)
        await self._send(ws, "раз", attachment_ids=[str(attachment.id)], nonce="a1")
        second = await self._send(
            ws, "два", attachment_ids=[str(attachment.id)], nonce="a2")
        self.assertEqual(second["message"]["attachments"], [])
        await ws.disconnect()

    # --- реакции ---
    async def test_reaction_add_toggle_and_counter(self):
        member_ws = await self._connect(self.member)
        owner_ws = await self._connect(self.owner)
        sent = await self._send(member_ws, "оцените")
        await self._receive_until(owner_ws, "message_create")
        message_id = sent["message"]["id"]

        # Рассылка уходит в группу СЕРВЕРА, то есть и автору действия тоже.
        # Вычитываем её у обоих сокетов после каждого шага — иначе следующая
        # проверка достала бы из очереди эхо предыдущего действия и увидела
        # устаревший счётчик.
        async def react(sender, op, emoji):
            await sender.send_json_to({
                "op": op, "message_id": message_id, "emoji": emoji})
            mine = await self._receive_until(member_ws, "message_reactions")
            theirs = await self._receive_until(owner_ws, "message_reactions")
            self.assertEqual(mine["reactions"], theirs["reactions"])
            return mine

        seen = await react(member_ws, "add_reaction", "🔥")
        self.assertEqual(seen["message_id"], message_id)
        self.assertEqual(seen["reactions"], [
            {"emoji": "🔥", "count": 1, "user_ids": [self.member.id]}])

        # Второй человек той же реакцией — счётчик растёт, строка остаётся одна.
        seen = await react(owner_ws, "add_reaction", "🔥")
        self.assertEqual(len(seen["reactions"]), 1)
        self.assertEqual(seen["reactions"][0]["count"], 2)
        self.assertCountEqual(
            seen["reactions"][0]["user_ids"], [self.member.id, self.owner.id])

        # Снятие своей реакции уменьшает счётчик, чужая остаётся.
        seen = await react(member_ws, "remove_reaction", "🔥")
        self.assertEqual(seen["reactions"], [
            {"emoji": "🔥", "count": 1, "user_ids": [self.owner.id]}])

        await member_ws.disconnect()
        await owner_ws.disconnect()

    async def test_same_reaction_twice_is_idempotent(self):
        """Двойной клик или вторая вкладка не должны давать счётчик 2 от
        одного человека — на уровне БД это закрыто unique-констрейнтом."""
        ws = await self._connect(self.member)
        sent = await self._send(ws, "тест")
        message_id = sent["message"]["id"]
        for _ in range(2):
            await ws.send_json_to({
                "op": "add_reaction", "message_id": message_id, "emoji": "👍"})
            seen = await self._receive_until(ws, "message_reactions")
        self.assertEqual(seen["reactions"][0]["count"], 1)
        await ws.disconnect()

    async def test_one_user_can_place_all_twenty_reactions(self):
        """Лимит — на число РАЗНЫХ эмодзи у сообщения, а не на человека:
        один пользователь волен поставить все 20 сам."""
        ws = await self._connect(self.member)
        sent = await self._send(ws, "все двадцать")
        message_id = sent["message"]["id"]
        pool = ["🔥", "👍", "🎉", "😂", "😮", "😢", "💯", "🚀", "🐱", "🍕",
                "⚽", "🎮", "🌈", "⭐", "🍀", "🎁", "🏆", "🥁", "🦄", "🐸"]
        self.assertEqual(len(pool), MAX_REACTIONS_PER_MESSAGE)

        for char in pool:
            await ws.send_json_to({
                "op": "add_reaction", "message_id": message_id, "emoji": char})
            await self._receive_until(ws, "message_reactions")

        count = await sync_to_async(
            Reaction.objects.filter(
                message_id=message_id, user=self.member).count)()
        self.assertEqual(count, MAX_REACTIONS_PER_MESSAGE)
        await ws.disconnect()

    async def test_reaction_limit_blocks_next_distinct_emoji(self):
        ws = await self._connect(self.member)
        sent = await self._send(ws, "лимит")
        message_id = sent["message"]["id"]

        @database_sync_to_async
        def fill():
            pool = ["🔥", "👍", "🎉", "😂", "😮", "😢", "💯", "🚀", "🐱", "🍕",
                    "⚽", "🎮", "🌈", "⭐", "🍀", "🎁", "🏆", "🥁", "🦄", "🐸"]
            Reaction.objects.bulk_create([
                Reaction(message_id=message_id, user=self.owner, emoji=char)
                for char in pool
            ])

        await fill()
        await ws.send_json_to({
            "op": "add_reaction", "message_id": message_id, "emoji": "🍏"})
        self.assertTrue(await ws.receive_nothing(timeout=0.3))

        exists = await sync_to_async(
            Reaction.objects.filter(message_id=message_id, emoji="🍏").exists)()
        self.assertFalse(exists)
        await ws.disconnect()

    async def test_existing_reaction_still_joinable_at_limit(self):
        """Упёршись в 20 разных, присоединиться к УЖЕ стоящей реакции всё ещё
        можно: ограничение на ширину ленты, а не на число участников."""
        ws = await self._connect(self.member)
        sent = await self._send(ws, "лимит, но не для всех")
        message_id = sent["message"]["id"]

        @database_sync_to_async
        def fill():
            pool = ["🔥", "👍", "🎉", "😂", "😮", "😢", "💯", "🚀", "🐱", "🍕",
                    "⚽", "🎮", "🌈", "⭐", "🍀", "🎁", "🏆", "🥁", "🦄", "🐸"]
            Reaction.objects.bulk_create([
                Reaction(message_id=message_id, user=self.owner, emoji=char)
                for char in pool
            ])

        await fill()
        await ws.send_json_to({
            "op": "add_reaction", "message_id": message_id, "emoji": "🔥"})
        seen = await self._receive_until(ws, "message_reactions")
        fire = next(r for r in seen["reactions"] if r["emoji"] == "🔥")
        self.assertEqual(fire["count"], 2)
        await ws.disconnect()

    async def test_outsider_cannot_react(self):
        member_ws = await self._connect(self.member)
        sent = await self._send(member_ws, "не для чужих")
        message_id = sent["message"]["id"]

        outsider_ws = await self._connect(self.outsider)
        await outsider_ws.send_json_to({
            "op": "add_reaction", "message_id": message_id, "emoji": "🔥"})
        self.assertTrue(await member_ws.receive_nothing(timeout=0.3))

        exists = await sync_to_async(
            Reaction.objects.filter(message_id=message_id).exists)()
        self.assertFalse(exists)

        await member_ws.disconnect()
        await outsider_ws.disconnect()

    async def test_non_emoji_reaction_rejected(self):
        ws = await self._connect(self.member)
        sent = await self._send(ws, "текст вместо эмодзи")
        message_id = sent["message"]["id"]
        await ws.send_json_to({
            "op": "add_reaction", "message_id": message_id, "emoji": "ХАХАХА"})
        self.assertTrue(await ws.receive_nothing(timeout=0.3))
        await ws.disconnect()

    async def test_deleting_message_removes_its_reactions(self):
        ws = await self._connect(self.member)
        sent = await self._send(ws, "удалю")
        message_id = sent["message"]["id"]
        await ws.send_json_to({
            "op": "add_reaction", "message_id": message_id, "emoji": "🔥"})
        await self._receive_until(ws, "message_reactions")

        await ws.send_json_to({"op": "delete_message", "message_id": message_id})
        await self._receive_until(ws, "message_delete")

        left = await sync_to_async(
            Reaction.objects.filter(message_id=message_id).count)()
        self.assertEqual(left, 0)
        await ws.disconnect()


class ServerNotificationSettingsTests(APITestCase):
    """Личные настройки уведомлений/заглушения — GET/PATCH
    /api/servers/<id>/settings. Не требуют никакого права сверх членства."""

    def setUp(self):
        self.owner = User.objects.create_user(username="ns_owner", password="pw12345")
        self.member = User.objects.create_user(username="ns_member", password="pw12345")
        self.outsider = User.objects.create_user(username="ns_out", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)

    def test_default_settings(self):
        self.client.force_authenticate(self.member)
        resp = self.client.get(f"/api/servers/{self.server.id}/settings")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["notification_level"], "all")
        self.assertFalse(resp.data["muted"])
        self.assertTrue(resp.data["allow_dms_from_server"])

    def test_non_member_cannot_read_or_write_settings(self):
        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.get(f"/api/servers/{self.server.id}/settings").status_code, 404)
        self.assertEqual(
            self.client.patch(
                f"/api/servers/{self.server.id}/settings",
                {"notification_level": "none"}, format="json").status_code,
            404,
        )

    def test_change_notification_level(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"notification_level": "mentions"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["notification_level"], "mentions")
        membership = Membership.objects.get(user=self.member, server=self.server)
        self.assertEqual(membership.notification_level, Membership.NOTIFY_MENTIONS)

    def test_mute_for_duration(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"mute_minutes": 30}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.data["muted"])
        self.assertFalse(resp.data["muted_forever"])
        membership = Membership.objects.get(user=self.member, server=self.server)
        self.assertTrue(membership.is_muted())
        self.assertLess(
            membership.muted_until, timezone.now() + timedelta(minutes=31))

    def test_mute_forever_then_unmute(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"mute_forever": True}, format="json")
        self.assertTrue(resp.data["muted"])
        self.assertTrue(resp.data["muted_forever"])

        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"unmute": True}, format="json")
        self.assertFalse(resp.data["muted"])
        self.assertFalse(resp.data["muted_forever"])
        self.assertIsNone(resp.data["muted_until"])

    def test_invalid_mute_minutes_rejected(self):
        self.client.force_authenticate(self.member)
        for bad in (0, -5, 60 * 24 * 31):
            resp = self.client.patch(
                f"/api/servers/{self.server.id}/settings",
                {"mute_minutes": bad}, format="json")
            self.assertEqual(resp.status_code, 400, msg=f"mute_minutes={bad}")

    def test_conflicting_mute_ops_rejected(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"mute_minutes": 30, "mute_forever": True}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_settings_surface_on_server_list(self):
        """my_settings приезжает вместе со списком серверов — без отдельного
        похода за каждым, см. ServerSerializer.get_my_settings."""
        Membership.objects.filter(user=self.member, server=self.server).update(
            notification_level=Membership.NOTIFY_NONE, muted_forever=True)
        self.client.force_authenticate(self.member)
        resp = self.client.get("/api/servers")
        entry = next(s for s in resp.data if s["id"] == self.server.id)
        self.assertEqual(entry["my_settings"]["notification_level"], "none")
        self.assertTrue(entry["my_settings"]["muted"])


class RoleMentionPermissionTests(APITestCase):
    """Кто может пинговать роль (Role.mention_permission/mentionable_by)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="rm_owner", password="pw12345")
        self.mod = User.objects.create_user(username="rm_mod", password="pw12345")
        self.member = User.objects.create_user(username="rm_member", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        for u in (self.owner, self.mod, self.member):
            Membership.objects.create(user=u, server=self.server)
        self.default_role = roles.create_default_role(self.server)
        self.mod_role = Role.objects.create(
            server=self.server, name="Модератор", position=10, manage_roles=True)
        Membership.objects.get(user=self.mod, server=self.server).roles.add(self.mod_role)

    def test_role_defaults_to_mentionable_by_everyone(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.get(f"/api/servers/{self.server.id}/roles")
        target = next(r for r in resp.data if r["id"] == self.mod_role.id)
        self.assertEqual(target["mention_permission"], "everyone")
        self.assertEqual(target["mentionable_by"], [])

    def test_restrict_mention_to_selected_roles(self):
        # Заводим отдельную роль "Пинговать модеров" и разрешаем именно ей.
        self.client.force_authenticate(self.owner)
        pinger_role = self.client.post(
            f"/api/servers/{self.server.id}/roles",
            {"name": "Может звать модеров", "position": 1}, format="json").data

        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{self.mod_role.id}",
            {"mention_permission": "roles", "mentionable_by": [pinger_role["id"]]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["mention_permission"], "roles")
        self.assertEqual(resp.data["mentionable_by"], [pinger_role["id"]])

    def test_mentionable_by_rejects_role_from_another_server(self):
        other_server = Server.objects.create(name="other", owner=self.owner)
        foreign_role = Role.objects.create(
            server=other_server, name="Чужая", position=1)
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{self.mod_role.id}",
            {"mention_permission": "roles", "mentionable_by": [foreign_role.id]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_editing_mentionable_by_still_requires_manage_roles(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/roles/{self.mod_role.id}",
            {"mentionable_by": []}, format="json")
        self.assertEqual(resp.status_code, 403)


class ServerInviteTests(APITestCase):
    """Приглашения — личные (direct) и по ссылке (link). Оба обходят
    access_mode целиком; бан по-прежнему блокирует вход."""

    def setUp(self):
        self.owner = User.objects.create_user(username="inv_owner", password="pw12345")
        self.member = User.objects.create_user(username="inv_member", password="pw12345")
        self.friend = User.objects.create_user(username="inv_friend", password="pw12345")
        self.server = Server.objects.create(
            name="s", owner=self.owner, access_mode=Server.ACCESS_INVITE)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)

    def test_member_can_invite_to_invite_only_server(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json")
        self.assertEqual(resp.status_code, 201)

        self.client.force_authenticate(self.friend)
        mine = self.client.get("/api/invites").data
        self.assertEqual(len(mine), 1)
        invite_id = mine[0]["id"]

        # Обычный join по-прежнему отказал бы — access_mode=invite.
        self.assertEqual(
            self.client.post(f"/api/servers/{self.server.id}/join").status_code, 403)

        accept = self.client.post(f"/api/invites/{invite_id}")
        self.assertEqual(accept.status_code, 200)
        self.assertTrue(
            Membership.objects.filter(user=self.friend, server=self.server).exists())
        # Приглашение остаётся карточкой в переписке (см. ConversationMessage.
        # server_invite) — теперь принятое, а не удалённое.
        invite = ServerInvite.objects.get(id=invite_id)
        self.assertEqual(invite.status, ServerInvite.ACCEPTED)
        # Больше не отдаётся списком "Приглашения" — он уже решён.
        self.assertEqual(len(self.client.get("/api/invites").data), 0)

    def test_invite_duplicate_is_idempotent(self):
        self.client.force_authenticate(self.member)
        first = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json")
        second = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json")
        self.assertEqual(first.data["id"], second.data["id"])
        self.assertEqual(ServerInvite.objects.count(), 1)

    def test_cannot_invite_existing_member(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.owner.id}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_banned_user_cannot_be_invited(self):
        ServerBan.objects.create(server=self.server, user=self.friend)
        self.client.force_authenticate(self.member)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_banned_invitee_cannot_accept(self):
        self.client.force_authenticate(self.member)
        invite = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json").data

        ServerBan.objects.create(server=self.server, user=self.friend)
        self.client.force_authenticate(self.friend)
        resp = self.client.post(f"/api/invites/{invite['id']}")
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(
            Membership.objects.filter(user=self.friend, server=self.server).exists())

    def test_decline_invite(self):
        self.client.force_authenticate(self.member)
        invite = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json").data

        self.client.force_authenticate(self.friend)
        resp = self.client.delete(f"/api/invites/{invite['id']}")
        self.assertEqual(resp.status_code, 204)
        self.assertEqual(
            ServerInvite.objects.get(id=invite["id"]).status, ServerInvite.DECLINED)

    def test_invite_arrives_as_dm_card_not_separate_list(self):
        """Приглашение больше не отдельная вкладка — это карточка сервера
        прямо в переписке с пригласившим (см. HomeSidebar/ServerInviteCard)."""
        self.client.force_authenticate(self.member)
        invite = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json").data

        conversation = Conversation.objects.get(
            kind=Conversation.DM,
            dm_key=Conversation.build_dm_key(self.member.id, self.friend.id))
        message = ConversationMessage.objects.get(conversation=conversation)
        self.assertEqual(message.author_id, self.member.id)
        self.assertEqual(message.server_invite_id, invite["id"])

        self.client.force_authenticate(self.friend)
        card = self.client.get(
            f"/api/conversations/{conversation.id}/messages").data[0]["server_invite"]
        self.assertEqual(card["status"], "pending")
        self.assertEqual(card["server"]["id"], self.server.id)
        self.assertEqual(card["server"]["member_count"], 2)

        accept = self.client.post(f"/api/invites/{invite['id']}")
        self.assertEqual(accept.status_code, 200)
        card_after = self.client.get(
            f"/api/conversations/{conversation.id}/messages").data[0]["server_invite"]
        self.assertEqual(card_after["status"], "accepted")

    def test_can_reinvite_after_decline(self):
        self.client.force_authenticate(self.member)
        first = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json").data

        self.client.force_authenticate(self.friend)
        self.client.delete(f"/api/invites/{first['id']}")

        self.client.force_authenticate(self.member)
        second = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json")
        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(second.data["id"], first["id"])

    def test_link_is_stable_across_requests(self):
        self.client.force_authenticate(self.owner)
        first = self.client.get(f"/api/servers/{self.server.id}/invite-link").data
        second = self.client.get(f"/api/servers/{self.server.id}/invite-link").data
        self.assertEqual(first["code"], second["code"])
        self.assertEqual(
            ServerInvite.objects.filter(server=self.server, kind=ServerInvite.LINK).count(), 1)

    def test_redeem_link_joins_invite_only_server(self):
        self.client.force_authenticate(self.owner)
        code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]

        self.client.force_authenticate(self.friend)
        resp = self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(
            Membership.objects.filter(user=self.friend, server=self.server).exists())

        # Ссылка многоразовая — второй редимпшен той же ссылки другим тоже
        # проходит и не портит уже созданное членство.
        another = User.objects.create_user(username="inv_another", password="pw12345")
        self.client.force_authenticate(another)
        resp2 = self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertEqual(resp2.status_code, 200)
        self.assertTrue(
            Membership.objects.filter(user=another, server=self.server).exists())

    def test_redeem_unknown_code(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.post(
            "/api/invites/redeem", {"code": "not-a-real-code"}, format="json")
        self.assertEqual(resp.status_code, 404)

    def test_banned_user_cannot_redeem_link(self):
        self.client.force_authenticate(self.owner)
        code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]
        ServerBan.objects.create(server=self.server, user=self.friend)

        self.client.force_authenticate(self.friend)
        resp = self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertEqual(resp.status_code, 403)

    def test_each_member_gets_own_link(self):
        self.client.force_authenticate(self.owner)
        owner_code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]

        self.client.force_authenticate(self.member)
        member_code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]

        self.assertNotEqual(owner_code, member_code)
        self.assertEqual(
            ServerInvite.objects.filter(server=self.server, kind=ServerInvite.LINK).count(), 2)

    def test_redeem_link_increments_uses_only_on_join(self):
        self.client.force_authenticate(self.member)
        resp = self.client.get(f"/api/servers/{self.server.id}/invite-link")
        code = resp.data["code"]
        # Просто получить свою ссылку (даже повторно) — не "использование".
        self.assertEqual(resp.data["uses"], 0)
        self.client.get(f"/api/servers/{self.server.id}/invite-link")
        self.assertEqual(
            ServerInvite.objects.get(server=self.server, created_by=self.member).uses, 0)

        self.client.force_authenticate(self.friend)
        self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertEqual(
            ServerInvite.objects.get(server=self.server, created_by=self.member).uses, 1)

        another = User.objects.create_user(username="inv_another2", password="pw12345")
        self.client.force_authenticate(another)
        self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertEqual(
            ServerInvite.objects.get(server=self.server, created_by=self.member).uses, 2)

    def test_invite_links_list_requires_manage_members(self):
        self.client.force_authenticate(self.member)
        resp = self.client.get(f"/api/servers/{self.server.id}/invite-links")
        self.assertEqual(resp.status_code, 403)

    def test_invite_links_list_shows_every_members_link(self):
        self.client.force_authenticate(self.owner)
        self.client.get(f"/api/servers/{self.server.id}/invite-link")
        self.client.force_authenticate(self.member)
        code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]
        self.client.force_authenticate(self.friend)
        self.client.post("/api/invites/redeem", {"code": code}, format="json")

        self.client.force_authenticate(self.owner)
        resp = self.client.get(f"/api/servers/{self.server.id}/invite-links")
        self.assertEqual(resp.status_code, 200)
        by_creator = {row["created_by"]["id"]: row for row in resp.data}
        self.assertEqual(len(by_creator), 2)
        self.assertEqual(by_creator[self.member.id]["uses"], 1)
        self.assertEqual(by_creator[self.owner.id]["uses"], 0)


class ChannelStatusAndPinTests(APITestCase):
    """PATCH /api/channels/<id> (статус канала) и pinned_channel_ids личных
    настроек (см. правый клик по голосовому каналу — ChannelContextMenu)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="cs_owner", password="pw12345")
        self.member = User.objects.create_user(username="cs_member", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)
        self.channel = Channel.objects.create(
            server=self.server, name="general", kind=Channel.VOICE, position=0)
        self.other_channel = Channel.objects.create(
            server=self.server, name="afk", kind=Channel.VOICE, position=1)

    def test_owner_can_set_channel_status(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/channels/{self.channel.id}", {"status": "играем в CS"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["status"], "играем в CS")
        self.channel.refresh_from_db()
        self.assertEqual(self.channel.status, "играем в CS")

    def test_status_is_trimmed_and_capped(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.patch(
            f"/api/channels/{self.channel.id}", {"status": "  " + "x" * 200 + "  "},
            format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["status"]), 120)
        self.assertFalse(resp.data["status"].startswith(" "))

    def test_regular_member_cannot_set_status(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/channels/{self.channel.id}", {"status": "тест"}, format="json")
        self.assertEqual(resp.status_code, 403)

    def test_pin_channel_persists(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"pinned_channel_ids": [self.channel.id]}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["pinned_channel_ids"], [self.channel.id])
        # И правда сохранилось, не просто эхо запроса.
        again = self.client.get(f"/api/servers/{self.server.id}/settings").data
        self.assertEqual(again["pinned_channel_ids"], [self.channel.id])

    def test_pin_rejects_channel_from_another_server(self):
        other_server = Server.objects.create(name="s2", owner=self.owner)
        Membership.objects.create(user=self.member, server=other_server)
        foreign_channel = Channel.objects.create(
            server=other_server, name="v", kind=Channel.VOICE, position=0)
        self.client.force_authenticate(self.member)
        resp = self.client.patch(
            f"/api/servers/{self.server.id}/settings",
            {"pinned_channel_ids": [foreign_channel.id]}, format="json")
        self.assertEqual(resp.status_code, 400)


class ChannelInviteTests(APITestCase):
    """Приглашение в КОНКРЕТНЫЙ голосовой канал (ServerInvite.channel) —
    отдельная ветка от общего серверного приглашения (см. ServerInviteTests):
    можно звать уже состоящего на сервере друга, ссылка своя на каждый канал,
    переход по ней сначала показывает предпросмотр (InvitePreview), а не
    вступает мгновенно."""

    def setUp(self):
        self.owner = User.objects.create_user(username="ci_owner", password="pw12345")
        self.member = User.objects.create_user(username="ci_member", password="pw12345")
        self.friend = User.objects.create_user(username="ci_friend", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)
        self.channel = Channel.objects.create(
            server=self.server, name="general", kind=Channel.VOICE, position=0)

    def test_can_invite_existing_member_to_specific_channel(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.member.id, "channel_id": self.channel.id}, format="json")
        self.assertEqual(resp.status_code, 201)
        invite = ServerInvite.objects.get(id=resp.data["id"])
        self.assertEqual(invite.channel_id, self.channel.id)

    def test_general_invite_to_existing_member_still_blocked(self):
        """Канал не указан — старое поведение (нельзя звать уже состоящего
        на сервере) не сломано."""
        self.client.force_authenticate(self.owner)
        resp = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.member.id}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_general_and_channel_invite_to_same_person_coexist(self):
        self.client.force_authenticate(self.owner)
        general = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json")
        self.assertEqual(general.status_code, 201)
        channel_invite = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id, "channel_id": self.channel.id}, format="json")
        self.assertEqual(channel_invite.status_code, 201)
        self.assertNotEqual(general.data["id"], channel_invite.data["id"])

    def test_channel_link_is_separate_from_server_link(self):
        self.client.force_authenticate(self.owner)
        server_link = self.client.get(
            f"/api/servers/{self.server.id}/invite-link").data["code"]
        channel_link = self.client.get(
            f"/api/servers/{self.server.id}/invite-link",
            {"channel_id": self.channel.id}).data["code"]
        self.assertNotEqual(server_link, channel_link)
        # Повторный запрос той же ссылки на канал — тот же код, не плодит новые.
        channel_link_again = self.client.get(
            f"/api/servers/{self.server.id}/invite-link",
            {"channel_id": self.channel.id}).data["code"]
        self.assertEqual(channel_link, channel_link_again)

    def test_preview_returns_server_and_channel_without_joining(self):
        self.client.force_authenticate(self.owner)
        code = self.client.get(
            f"/api/servers/{self.server.id}/invite-link",
            {"channel_id": self.channel.id}).data["code"]

        self.client.force_authenticate(self.friend)
        preview = self.client.get("/api/invites/preview", {"code": code})
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.data["server"]["id"], self.server.id)
        self.assertEqual(preview.data["channel"]["id"], self.channel.id)
        self.assertFalse(preview.data["already_member"])
        # Предпросмотр не должен был вступить на сервер.
        self.assertFalse(
            Membership.objects.filter(user=self.friend, server=self.server).exists())

    def test_preview_unknown_code_404(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.get("/api/invites/preview", {"code": "nope"})
        self.assertEqual(resp.status_code, 404)

    def test_preview_rejects_plain_server_link(self):
        """/preview — только для приглашений с каналом; голый серверный код
        (используемый мгновенным ServerInviteRedeem) сюда не годится."""
        self.client.force_authenticate(self.owner)
        code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]
        self.client.force_authenticate(self.friend)
        resp = self.client.get("/api/invites/preview", {"code": code})
        self.assertEqual(resp.status_code, 404)

    def test_redeem_channel_link_returns_channel_id_and_joins(self):
        self.client.force_authenticate(self.owner)
        code = self.client.get(
            f"/api/servers/{self.server.id}/invite-link",
            {"channel_id": self.channel.id}).data["code"]

        self.client.force_authenticate(self.friend)
        resp = self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["invited_channel_id"], self.channel.id)
        self.assertTrue(
            Membership.objects.filter(user=self.friend, server=self.server).exists())

    def test_redeem_plain_server_link_has_null_channel_id(self):
        self.client.force_authenticate(self.owner)
        code = self.client.get(f"/api/servers/{self.server.id}/invite-link").data["code"]
        self.client.force_authenticate(self.friend)
        resp = self.client.post("/api/invites/redeem", {"code": code}, format="json")
        self.assertIsNone(resp.data["invited_channel_id"])

    def test_direct_channel_invite_card_shows_channel_and_accept_returns_id(self):
        """Карточка «Пригласить в голосовой чат» другу (см. ChannelInviteModal)
        — та же карточка server_invite, что и у обычного приглашения, но с
        channel; принятие возвращает invited_channel_id для автоподключения."""
        self.client.force_authenticate(self.owner)
        invite = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id, "channel_id": self.channel.id}, format="json").data
        self.assertEqual(invite["channel"]["id"], self.channel.id)

        self.client.force_authenticate(self.friend)
        accept = self.client.post(f"/api/invites/{invite['id']}")
        self.assertEqual(accept.status_code, 200)
        self.assertEqual(accept.data["invited_channel_id"], self.channel.id)

    def test_general_direct_invite_card_has_null_channel(self):
        self.client.force_authenticate(self.owner)
        invite = self.client.post(
            f"/api/servers/{self.server.id}/invites",
            {"user_id": self.friend.id}, format="json").data
        self.assertIsNone(invite["channel"])


class ServerLeaveTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="lv_owner", password="pw12345")
        self.member = User.objects.create_user(username="lv_member", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.owner)
        Membership.objects.create(user=self.owner, server=self.server)
        Membership.objects.create(user=self.member, server=self.server)

    def test_member_can_leave(self):
        self.client.force_authenticate(self.member)
        resp = self.client.delete(f"/api/servers/{self.server.id}/leave")
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(
            Membership.objects.filter(user=self.member, server=self.server).exists())

    def test_owner_cannot_leave(self):
        self.client.force_authenticate(self.owner)
        resp = self.client.delete(f"/api/servers/{self.server.id}/leave")
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(
            Membership.objects.filter(user=self.owner, server=self.server).exists())

    def test_non_member_cannot_leave(self):
        outsider = User.objects.create_user(username="lv_out", password="pw12345")
        self.client.force_authenticate(outsider)
        resp = self.client.delete(f"/api/servers/{self.server.id}/leave")
        self.assertEqual(resp.status_code, 403)


class CrossServerDmPrivacyTests(APITestCase):
    """can_dm: общий сервер с allow_dms_from_server=True даёт исключение из
    dm_privacy=FRIENDS, но не из dm_privacy=NOBODY."""

    def setUp(self):
        self.a = User.objects.create_user(username="dm_a", password="pw12345")
        self.b = User.objects.create_user(username="dm_b", password="pw12345")
        self.server = Server.objects.create(name="s", owner=self.b)
        Membership.objects.create(user=self.a, server=self.server)
        Membership.objects.create(user=self.b, server=self.server)

    def test_friends_only_blocks_stranger_without_shared_server_opt_in(self):
        self.b.dm_privacy = self.b.DM_FRIENDS
        self.b.save(update_fields=["dm_privacy"])
        Membership.objects.filter(user=self.b, server=self.server).update(
            allow_dms_from_server=False)
        self.assertFalse(can_dm(self.a, self.b))

    def test_friends_only_allows_via_shared_server_opt_in(self):
        self.b.dm_privacy = self.b.DM_FRIENDS
        self.b.save(update_fields=["dm_privacy"])
        # allow_dms_from_server=True — дефолт, не трогаем.
        self.assertTrue(can_dm(self.a, self.b))

    def test_nobody_blocks_even_with_shared_server_opt_in(self):
        self.b.dm_privacy = self.b.DM_NOBODY
        self.b.save(update_fields=["dm_privacy"])
        self.assertFalse(can_dm(self.a, self.b))

    def test_dm_creation_endpoint_honors_shared_server_exception(self):
        self.b.dm_privacy = self.b.DM_FRIENDS
        self.b.save(update_fields=["dm_privacy"])
        self.client.force_authenticate(self.a)
        resp = self.client.post(
            "/api/conversations",
            {"kind": "dm", "user_ids": [self.b.id]}, format="json")
        # 201 — новый диалог создан (первый между этой парой); can_dm() уже
        # пройден внутри _create_dm, до создания Conversation.
        self.assertEqual(resp.status_code, 201)
