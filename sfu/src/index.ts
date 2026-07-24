import { initWorkers } from './worker'
import { startServer } from './server'

async function main() {
  await initWorkers()
  startServer()
}

main().catch((err) => {
  console.error('[sfu] fatal:', err)
  process.exit(1)
})
