import { useCallback, useState } from 'react'

type CloseFn = () => void

/** Какое контекстное меню/попап, открытый правым кликом, сейчас единственный
 * активный — см. useContextMenuState ниже. Модуль-синглтон, а не React-стейт:
 * участников много (друг/диалог/участник войса/сервер/канал/сообщение/эмодзи
 * в пикере — см. каждый useContextMenuState), и заводить для их координации
 * ещё один компонент-провайдер ради одного указателя незачем. */
let active: CloseFn | null = null

/** Замена useState<T | null>(null) для состояния попапа, открываемого правым
 * кликом (позиция курсора + цель). Открытие такого попапа закрывает любой
 * другой, открытый тем же способом — иначе правый клик по одному, пока
 * открыт другой (например, участник в members-list, пока ещё не закрылось
 * меню сообщения), оставлял бы оба на экране разом, и они бы перекрывались.
 *
 * Сигнатура намеренно совпадает с useState, чтобы менять только объявление,
 * не трогая остальной код компонента/хука (setX({...}) / setX(null) и так
 * далее работают как раньше). */
export function useContextMenuState<T>(): [T | null, (value: T | null) => void] {
  const [value, setValue] = useState<T | null>(null)
  const close = useCallback(() => setValue(null), [])
  const set = useCallback(
    (next: T | null) => {
      if (next == null) {
        if (active === close) active = null
        setValue(null)
        return
      }
      // Тот же попап просто переоткрылся на новом месте (повторный правый
      // клик по своей же цели) — самого себя закрывать не нужно.
      if (active && active !== close) active()
      active = close
      setValue(next)
    },
    [close],
  )
  return [value, set]
}
