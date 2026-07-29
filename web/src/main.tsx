import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Запрет жестового зума (пинч на тачскрине/трекпаде) — обычный зум страницы
// клавиатурой (Ctrl+/Ctrl-, меню браузера) НЕ трогаем: это уровень браузера,
// странице такие события вообще не видны, preventDefault на них не влияет.
//
// gesturestart/gesturechange — нестандартные Safari-события ровно для
// двухпальцевого пинча (десктопный Safari и iOS), другие браузеры их не
// шлют вовсе. wheel с ctrlKey — то, чем Chrome/Firefox/Edge синтезируют И
// пинч-жест на трекпаде (macOS отдаёт его браузеру как "зум", браузер
// транслirует в wheel+ctrlKey), И Ctrl+колесо мыши — из
// JS отличить одно от другого нельзя, поэтому блокируется оба разом; это и
// есть тот самый "масштаб можно, а зумить нельзя" в границах того, что
// вообще доступно странице.
declare global {
  interface DocumentEventMap {
    gesturestart: Event
    gesturechange: Event
  }
}
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('gesturechange', (e) => e.preventDefault())
document.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault()
  },
  { passive: false },
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
