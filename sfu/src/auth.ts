import jwt from 'jsonwebtoken'
import { config } from './config'

export interface TokenClaims {
  uid: number
  room: string
  name?: string
  /** Права роли на сервере (см. chat/sfu.py). В токенах, выпущенных до их
   * появления, отсутствуют — тогда считаем разрешённым (см. Peer). */
  speak?: boolean
  video?: boolean
}

/** Проверка access-токена, подписанного общим с Django секретом (SFU_SECRET).
 *
 * Живёт отдельным модулем, потому что нужна в двух местах: при открытии
 * соединения (server.ts, токен из query) и при обновлении прав уже
 * подключённого пира на лету (signaling.ts, action 'updateToken'). Явный
 * allow-list алгоритмов: иначе проверка опирается на дефолты библиотеки, а не
 * на наше решение.
 */
export function verifyToken(token: string): TokenClaims {
  return jwt.verify(token, config.sfuSecret, {
    algorithms: ['HS256'],
  }) as TokenClaims
}
