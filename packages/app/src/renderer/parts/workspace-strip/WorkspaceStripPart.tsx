import { WorkspaceStrip, type WorkspaceStripProps } from "../../components/WorkspaceStrip";

export type WorkspaceStripPartProps = WorkspaceStripProps;

export function WorkspaceStripPart(props: WorkspaceStripPartProps): JSX.Element {
  return <WorkspaceStrip {...props} />;
}
