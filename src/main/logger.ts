import log from 'electron-log/main'
import { join } from 'path'

log.transports.file.resolvePathFn = () => join(process.cwd(), 'logs', 'main.log')
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
log.transports.file.level = 'debug'

log.transports.console.level = 'debug'

export default log
