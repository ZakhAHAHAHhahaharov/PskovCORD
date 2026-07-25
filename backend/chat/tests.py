"""
Тесты голосовой «меты» (presence/peers/mute), SFU access-токена и TURN-хелпера.
Медиа-транспорт голоса вынесен в отдельный SFU-сервис (mediasoup), поэтому
mesh-сигналинга offer/answer/ice в gateway больше нет.
"""
import base64
import hashlib
import hmac
import time

import jwt
from asgiref.sync import sync_to_async
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from . import presence, sfu, turn
from .consumers import GatewayConsumer
from .middleware import JWTAuthMiddleware
from .models import Channel, Membership, Message, Server

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
        nothing = await owner_ws.receive_nothing(timeout=0.3)
        if not nothing:
            leaked = await owner_ws.receive_json_from(timeout=0.1)
            print("DEBUG LEAKED MESSAGE (delete test):", leaked)
        self.assertTrue(nothing)
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
        nothing = await member_ws.receive_nothing(timeout=0.3)
        if not nothing:
            leaked = await member_ws.receive_json_from(timeout=0.1)
            print("DEBUG LEAKED MESSAGE (edit test):", leaked)
        self.assertTrue(nothing)
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
