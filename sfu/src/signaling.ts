import type { types } from 'mediasoup'
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
      const producer = await transport.produce({
        kind: data.kind as types.MediaKind,
        rtpParameters: data.rtpParameters,
        appData: { userId: peer.userId, peerId: peer.id, source },
      })
      peer.producers.set(producer.id, producer)
      // Оповещаем остальных — пусть создадут consumer на этот producer.
      room.broadcast(peer, 'newProducer', {
        producerId: producer.id,
        userId: peer.userId,
        source,
      })
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
      const owner = found ? found.userId : null
      const source =
        (found?.producer.appData as { source?: string } | undefined)?.source ?? 'mic'
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

    default:
      throw new Error(`unknown action: ${action}`)
  }
}
