"""
Тесты голосовой «меты» (presence/peers/mute), SFU access-токена и TURN-хелпера.
Медиа-транспорт голоса вынесен в отдельный SFU-сервис (mediasoup), поэтому
mesh-сигналинга offer/answer/ice в gateway больше нет.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import time

import jwt
from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from . import mute_vote, presence, roles, sfu, turn
from .consumers import GatewayConsumer
from .middleware import JWTAuthMiddleware
from .models import (
    Channel, Conversation, ConversationParticipant, Membership, Message, Role,
    Server, ServerJoinRequest, dm_room,
)

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

    def test_private_server_hides_description_from_outsiders(self):
        self.server.is_private = True
        self.server.description = "секретное описание"
        self.server.tags = ["тайна"]
        self.server.save(update_fields=["is_private", "description", "tags"])

        self.client.force_authenticate(self.outsider)
        entry = next(
            s for s in self.client.get("/api/servers/discover").data
            if s["id"] == self.server.id
        )
        self.assertEqual(entry["name"], self.server.name)  # имя видно всем
        self.assertEqual(entry["description"], "")
        self.assertEqual(entry["tags"], [])

        self.client.force_authenticate(self.owner)
        entry = next(
            s for s in self.client.get("/api/servers/discover").data
            if s["id"] == self.server.id
        )
        self.assertEqual(entry["description"], "секретное описание")

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
