export interface WorkspaceConfig {
  [key: string]: unknown
}

export interface WorkspaceProps {
  id: string
  path: string
  name?: string
  config?: WorkspaceConfig
}

export class Workspace {
  readonly id: string
  readonly path: string
  readonly name: string | undefined
  readonly config: WorkspaceConfig

  constructor(props: WorkspaceProps) {
    this.id = props.id
    this.path = props.path
    this.name = props.name
    this.config = props.config ?? {}
  }
}
