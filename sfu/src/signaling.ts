import type { types } from 'mediasoup'
import { verifyToken } from './auth'
import { createWebRtcTransport } from './worker'
import { Room, Peer } from './room'

/**
 * Обработка одного запроса клиента к SFU. Протокол — простой request/response
 * поверх WS: клиент шлёт {id, action, data}, сервер отвечает {id, data|error}.
 * Порядок на клиенте (mediasoup-client):
 *   getRouterRtpCapabilities → Device.load
 *   createWebRtcTransport(recv|send) → connectWebRtcTransport (по DTLS)
 *   produce (микрофон, на send-транспорте)
 *   getProducers + consume (чужие треки, на recv-транспорте) → resumeConsumer
 * Плюс серверные уведомления: newProducer / producerClosed / peerClosed.
 *
 * blockScreenViewer {targetUserId, blocked} — запретить/разрешить конкретному
 * userId смотреть демонстрацию экрана ЭТОГО пира (см. Room.blockedScreenViewers).
 * blockMicListener {targetUserId, blocked} — то же самое, но для микрофона
 * (см. Room.blockedMicListeners).
 */
export async function handleRequest(
  room: Room,
  peer: Peer,
  action: string,
  data: any,
): Promise<unknown> {
  switch (action) {
    case 'getRouterRtpCapabilities':
      return room.router.rtpCapabilities

    case 'createWebRtcTransport': {
      const transport = await createWebRtcTransport(room.router)
      if (data?.direction === 'send') peer.sendTransport = transport
      else peer.recvTransport = transport
      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      }
    }

    case 'connectWebRtcTransport': {
      const transport = peer.transport(data.transportId)
      if (!transport) throw new Error('transport not found')
      await transport.connect({ dtlsParameters: data.dtlsParameters })
      return {}
    }

    case 'produce': {
      const transport = peer.transport(data.transportId)
      if (!transport) throw new Error('transport not found')
      // source отличает микрофон от демонстрации экрана ('mic' | 'screen').
      const source: string = data.source === 'screen' ? 'screen' : 'mic'
      // Права роли из токена — единственная их проверка на медиа-леге, см.
      // Peer.canSpeak/canVideo. До этого «Говорить: выкл» и «Показывать
      // видео: выкл» в редакторе ролей не значили ничего.
      if (source === 'screen' && !peer.canVideo) {
        throw new Error('screen share not allowed by server role')
      }
      if (source === 'mic' && !peer.canSpeak) {
        throw new Error('speaking not allowed by server role')
      }
      const producer = await transport.produce({
        kind: data.kind as types.MediaKind,
        rtpParameters: data.rtpParameters,
        appData: { userId: peer.userId, peerId: peer.id, source },
      })
      peer.producers.set(producer.id, producer)
      // Оповещаем остальных — пусть создадут consumer на этот producer.
      // Для демонстрации экрана — с учётом блок-листа (см. Room.broadcastScreenAware):
      // заблокированный зритель не должен даже увидеть, что демонстрация появилась.
      const notifyData = { producerId: producer.id, userId: peer.userId, source }
      if (source === 'screen') room.broadcastScreenAware(peer, 'newProducer', notifyData)
      else room.broadcastMicAware(peer, 'newProducer', notifyData)
      producer.on('transportclose', () => {
        peer.producers.delete(producer.id)
      })
      return { id: producer.id }
    }

    case 'closeProducer': {
      // Явная остановка продюсера (например, конец демонстрации экрана) —
      // закрываем и уведомляем остальных, чтобы убрали тайл/поток.
      const producer = peer.producers.get(data.producerId)
      if (!producer) return {}
      const source = (producer.appData as { source?: string }).source ?? 'mic'
      producer.close()
      peer.producers.delete(producer.id)
      room.broadcast(peer, 'producerClosed', {
        producerId: producer.id,
        userId: peer.userId,
        source,
      })
      return {}
    }

    case 'getProducers':
      return room.otherProducers(peer)

    case 'consume': {
      const transport = peer.recvTransport
      if (!transport) throw new Error('recv transport not created')
      if (!room.router.canConsume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
      })) {
        throw new Error('cannot consume')
      }
      const found = room.findProducer(data.producerId)
      const owner = found ? found.peer.userId : null
      const source =
        (found?.producer.appData as { source?: string } | undefined)?.source ?? 'mic'
      // Демонстрация экрана, а её владелец заблокировал именно этого зрителя —
      // отклоняем, даже если сам producerId откуда-то узнали (он и не должен
      // был попасть клиенту: getProducers/newProducer уже отфильтрованы, см.
      // Room.otherProducers/broadcastScreenAware).
      if (found && source === 'screen' && found.peer.blockedScreenViewers.has(peer.userId)) {
        throw new Error('blocked by screen share owner')
      }
      if (found && source === 'mic' && found.peer.blockedMicListeners.has(peer.userId)) {
        throw new Error('blocked by mic owner')
      }
      const consumer = await transport.consume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
        // Стартуем на паузе — клиент возобновит после setup консюмера.
        paused: true,
      })
      peer.consumers.set(consumer.id, consumer)
      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer.id)
      })
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id)
        peer.notify('consumerClosed', { consumerId: consumer.id })
      })
      return {
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerUserId: owner,
        source,
      }
    }

    case 'resumeConsumer': {
      const consumer = peer.consumers.get(data.consumerId)
      if (!consumer) throw new Error('consumer not found')
      await consumer.resume()
      return {}
    }

    case 'blockScreenViewer': {
      // Запрет/разрешение конкретному userId смотреть демонстрацию ЭТОГО
      // пира. Действует на всё время текущего подключения к SFU (не
      // персистится) — см. Room.otherProducers/broadcastScreenAware (не
      // узнает о новых демках) и consume (не сможет запросить существующую).
      const targetUserId = Number(data.targetUserId)
      const blocked = !!data.blocked
      // О смене доступа заблокированного нужно ЯВНО известить: клиент знает
      // о чужих демонстрациях только из getProducers (снимок на входе в
      // комнату) и newProducer/producerClosed. Раньше снятие запрета не
      // порождало ни того, ни другого — у зрителя так и не появлялось, что
      // смотреть, и помогал только выход и повторный вход в канал.
      const screenProducers = room.screenProducersOf(peer)
      if (blocked) {
        peer.blockedScreenViewers.add(targetUserId)
        room.closeScreenConsumersFor(peer, targetUserId)
        // producerClosed (а не только закрытие консюмеров) — чтобы у зрителя
        // ушла и сама пометка «есть что посмотреть», а не только картинка.
        for (const p of screenProducers) room.notifyUser(targetUserId, 'producerClosed', p)
      } else {
        peer.blockedScreenViewers.delete(targetUserId)
        for (const p of screenProducers) room.notifyUser(targetUserId, 'newProducer', p)
      }
      return {}
    }

    case 'blockMicListener': {
      // Запрет/разрешение конкретному userId слышать микрофон ЭТОГО пира —
      // тот же принцип, что blockScreenViewer, только для source==='mic'
      // (см. Room.blockedMicListeners/otherProducers/broadcastMicAware/consume).
      const targetUserId = Number(data.targetUserId)
      const blocked = !!data.blocked
      const micProducers = room.micProducersOf(peer)
      if (blocked) {
        peer.blockedMicListeners.add(targetUserId)
        room.closeMicConsumersFor(peer, targetUserId)
        for (const p of micProducers) room.notifyUser(targetUserId, 'producerClosed', p)
      } else {
        peer.blockedMicListeners.delete(targetUserId)
        for (const p of micProducers) room.notifyUser(targetUserId, 'newProducer', p)
      }
      return {}
    }

    case 'updateToken': {
      // Свежий токен для УЖЕ подключённого пира: права роли едут в токене
      // (см. chat/sfu.py), а он предъявляется один раз — при открытии
      // соединения. Поэтому право «Показывать видео», снятое и возвращённое
      // обратно, до этого действия оживало только после выхода и повторного
      // входа в голосовой канал. Токен по-прежнему выдаёт Django и только
      // тому, у кого право есть: подменить себе разрешение этим действием
      // нельзя.
      const claims = verifyToken(String(data?.token ?? ''))
      if (Number(claims.uid) !== peer.userId || String(claims.room) !== room.id) {
        throw new Error('token does not match this peer')
      }
      peer.canSpeak = claims.speak !== false
      peer.canVideo = claims.video !== false
      return { speak: peer.canSpeak, video: peer.canVideo }
    }

    case 'closeConsumer': {
      // Явный "перестать смотреть" (демонстрация экрана продолжается для
      // остальных — просто освобождаем ресурсы этого конкретного зрителя).
      const consumer = peer.consumers.get(data.consumerId)
      if (!consumer) return {}
      consumer.close()
      peer.consumers.delete(consumer.id)
      return {}
    }

    default:
      throw new Error(`unknown action: ${action}`)
  }
}
