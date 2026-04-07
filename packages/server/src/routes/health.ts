import { Hono } from 'hono'

const health = new Hono()

health.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

export default health
