// ESLint для веб-клиента.
//
// До этого в коде было с десяток `// eslint-disable-next-line
// react-hooks/exhaustive-deps`, а самого ESLint в проекте не было вовсе: ни
// конфига, ни пакета, ни скрипта. То есть правило, которое эти комментарии
// подавляют, никто не проверял — а именно оно поймало бы, например, эффект в
// voice.ts, который зависит от voice.room.id, но читает ещё и voice.sfuToken
// (из-за чего реконнект уходил в бесконечный цикл с протухшим токеном).
//
// exhaustive-deps намеренно оставлен предупреждением, а не ошибкой: в
// AppShell/voice.ts есть места, где зависимость опущена осознанно (и это
// прокомментировано рядом). Ошибка там заставила бы либо переписывать
// эффекты, либо снова навешивать disable-комментарии — то есть вернуться
// ровно к тому, с чего начали.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      // Правила из react-hooks v7, отключённые осознанно. Они запрещают
      // приём «writable ref, обновляемый при рендере» (voiceRef,
      // conversationsRef, mutedRef, micGainRef и др.) — а на нём в этом
      // проекте держится и чтение свежих значений в обработчиках WS, и
      // сокращение зависимостей больших эффектов. Переписывать это под новые
      // правила — отдельная задача с реальным риском регрессий в голосе;
      // включать их сейчас значило бы получить 18 ошибок на существующем
      // коде и приучиться прогонять линтер с --quiet, то есть не прогонять.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      // Код уже написан с `any` в паре мест на границе с mediasoup-client и
      // сырым JSON из WS — там это осознанно.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
