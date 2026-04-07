export const isDev = process.env['NODE_ENV'] !== 'production'

export const serverPort = process.env['SERVER_PORT']
  ? parseInt(process.env['SERVER_PORT'], 10)
  : 3000

export const webDevUrl = process.env['WEB_DEV_URL'] ?? 'http://localhost:5173'
