import { useWorkspaces } from '../hooks/use-workspaces'

export function WorkspaceList() {
  const { data, isLoading, isError, error } = useWorkspaces()

  if (isLoading) return <p>Loading workspaces...</p>
  if (isError) return <p>Error: {(error as Error).message}</p>
  if (!data || data.length === 0) return <p>No workspaces found.</p>

  return (
    <ul>
      {data.map((ws) => (
        <li key={ws.id}>
          <strong>{ws.name ?? ws.path}</strong>
          <span> — {ws.path}</span>
        </li>
      ))}
    </ul>
  )
}
