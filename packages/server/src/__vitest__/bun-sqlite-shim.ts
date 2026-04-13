// vitest 전용 shim: bun:sqlite → better-sqlite3
// 프로덕션 코드는 bun:sqlite를 직접 사용, 테스트 환경(Node/vitest)에서만 이 파일이 적용됨
import BetterDatabase from 'better-sqlite3'

export { BetterDatabase as Database }
export default BetterDatabase
