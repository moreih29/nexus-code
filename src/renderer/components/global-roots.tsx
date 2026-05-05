// Singleton mount roots — components that must be rendered exactly once
// at the App level, regardless of which workspace/group/tab is active.
//
// We collect them here so adding the next one (toast root, command
// palette, etc.) doesn't grow App.tsx. None of these compose props or
// listen for app-level state — they just need a fixed place in the
// React tree.

import { SaveConfirmDialogRoot } from "./ui/save-confirm-dialog";
import { ToastRoot } from "./ui/toast";
import { ViewParkRoot } from "./workspace/content/view-park";

export function GlobalRoots(): React.JSX.Element {
  return (
    <>
      <ViewParkRoot />
      <SaveConfirmDialogRoot />
      <ToastRoot />
    </>
  );
}
