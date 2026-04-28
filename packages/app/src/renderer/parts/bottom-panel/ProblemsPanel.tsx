import { GitBranch } from "lucide-react";

import { EmptyState } from "../../components/EmptyState";

export function ProblemsPanel(): JSX.Element {
  return (
    <section data-component="problems-panel" className="flex h-full min-h-0 bg-background text-foreground">
      <EmptyState
        icon={GitBranch}
        title="No problems"
        description="Diagnostics from language services will appear here."
      />
    </section>
  );
}
