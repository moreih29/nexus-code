import { SquareTerminal } from "lucide-react";

import { EmptyState } from "../../components/EmptyState";

export function OutputPanel(): JSX.Element {
  return (
    <section data-component="output-panel" className="flex h-full min-h-0 bg-background text-foreground">
      <EmptyState
        icon={SquareTerminal}
        title="No output yet"
        description="Task and extension output streams will appear here."
      />
    </section>
  );
}
