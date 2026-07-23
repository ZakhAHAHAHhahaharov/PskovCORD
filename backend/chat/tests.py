"""
Тесты голосового сигналинга и TURN-credentials (замена LiveKit).
"""
import base64
import hashlib
import hmac
import time

from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from . import presence, turn
from .consumers import GatewayConsumer
from .middleware import JWTAuthMiddleware
from .models import Channel, Membership, Server

User = get_user_model()


class PresenceVoiceTests(TestCase):
    def setUp(self):
        presence._r.flushdb()

    def tearDown(self):
        presence._r.flushdb()

    def test_first_member_has_no_peers(self):
        peers = presence.join_voice(1, 100)
        self.assertEqual(peers, [])
        self.assertEqual(presence.voice_member_ids(100), {"1"})

    def test_second_member_sees_first_as_peer(self):
        presence.join_voice(1, 100)
        peers = presence.join_voice(2, 100)
        self.assertEqual(peers, ["1"])

    def test_join_moves_between_channels(self):
        presence.join_voice(1, 100)
        presence.join_voice(1, 200)
        self.assertEqual(presence.voice_member_ids(100), set())
        self.assertEqual(presence.voice_member_ids(200), {"1"})

    def test_peers_never_include_self(self):
        presence.join_voice(1, 100)
        peers = presence.join_voice(1, 100)  # повторный join тем же uid
        self.assertEqual(peers, [])


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

    def test_member_gets_ice_servers(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(f"/api/channels/{self.voice_channel.id}/voice-credentials")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("ice_servers", resp.data)

    def test_non_member_forbidden(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.post(f"/api/channels/{self.voice_channel.id}/voice-credentials")
        self.assertEqual(resp.status_code, 403)

    def test_text_channel_rejected(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(f"/api/channels/{self.text_channel.id}/voice-credentials")
        self.assertEqual(resp.status_code, 400)


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
        """voice_join + дожидается СВОЕГО voice_peers и voice_state_update —
        второй идёт через group_send (Redis) и может прийти позже voice_peers
        (прямой self._send), иначе он "протекает" в последующие проверки."""
        await comm.send_json_to({"op": "voice_join", "channel_id": channel_id})
        peers_msg = None
        seen_own_state = False
        for _ in range(max_messages):
            msg = await comm.receive_json_from(timeout=timeout)
            if msg.get("op") == "voice_peers":
                peers_msg = msg
            elif msg.get("op") == "voice_state_update" and msg.get("channel_id") == channel_id:
                seen_own_state = True
            if peers_msg is not None and seen_own_state:
                return peers_msg
        raise AssertionError("voice_peers/voice_state_update не пришли за join")

    async def test_join_peers_and_offer_relay(self):
        alice_ws = await self._connect(self.alice)
        bob_ws = await self._connect(self.bob)

        peers_msg = await self._join_and_drain(alice_ws, self.voice_channel.id)
        self.assertEqual(peers_msg["peer_ids"], [])

        bob_peers = await self._join_and_drain(bob_ws, self.voice_channel.id)
        self.assertEqual(bob_peers["peer_ids"], [self.alice.id])
        # у alice ещё висит voice_state_update про вход bob — вычитываем,
        # чтобы не мешал следующей проверке relay.
        await self._receive_until(alice_ws, "voice_state_update")

        await bob_ws.send_json_to({
            "op": "voice_offer", "to_user_id": self.alice.id, "sdp": "fake-sdp",
        })
        offer = await self._receive_until(alice_ws, "voice_offer")
        self.assertEqual(offer["from_user_id"], self.bob.id)
        self.assertEqual(offer["sdp"], "fake-sdp")

        await alice_ws.disconnect()
        await bob_ws.disconnect()

    async def test_relay_dropped_outside_shared_voice_channel(self):
        alice_ws = await self._connect(self.alice)
        carol_ws = await self._connect(self.carol)

        # alice в голосовом канале, carol — нет (не шлёт voice_join).
        await self._join_and_drain(alice_ws, self.voice_channel.id)

        await carol_ws.send_json_to({
            "op": "voice_offer", "to_user_id": self.alice.id, "sdp": "should-not-arrive",
        })
        self.assertTrue(await alice_ws.receive_nothing(timeout=0.3))

        await alice_ws.disconnect()
        await carol_ws.disconnect()

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

    async def test_set_status_invalid_value_ignored(self):
        alice_ws = await self._connect(self.alice)
        await self._receive_until(alice_ws, "ready")
        await self._receive_until(alice_ws, "presence_update")

        await alice_ws.send_json_to({"op": "set_status", "status": "bogus"})
        self.assertTrue(await alice_ws.receive_nothing(timeout=0.3))

        await alice_ws.disconnect()
