/**
 * OpenCodeHostStub — AgentHost 인터페이스의 두 번째 컨슈머 컴파일 probe.
 *
 * 실제 동작 없이 TypeScript 컴파일 통과만 검증한다.
 * 런타임 또는 테스트에서 import되지 않도록 __tests__/ 폴더에 고정.
 */
import type { AgentHost, AgentHostConfig, AgentHostEvent } from '../agent-host.js'
import type { Result } from '../../result.js'

export class OpenCodeHostStub implements AgentHost {
  async spawn(_config: AgentHostConfig): Promise<Result<string>> {
    throw new Error('Not implemented')
  }

  async *observe(_sessionId: string): AsyncIterable<AgentHostEvent> {
    throw new Error('Not implemented')
  }

  async approve(_permissionId: string, _decision: { allow: boolean }): Promise<Result<void>> {
    throw new Error('Not implemented')
  }

  async reject(_permissionId: string, _reason: string): Promise<Result<void>> {
    throw new Error('Not implemented')
  }

  async dispose(_sessionId: string): Promise<Result<void>> {
    throw new Error('Not implemented')
  }
}
