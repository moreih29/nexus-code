// A select of an agent's profiles, each with its dot and name, for
// Settings: a workspace rule's profile, an agent's default, the manager's.

import { useTranslation } from "react-i18next";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import { cn } from "../../utils/cn";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ProfileDot, profileName } from "./profile-badge";

const INHERIT = "__inherit__";
const AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

/** A select of the agent's profiles, with "inherit" first when `inherit` names it. */
export function ProfileSelect({
  agent,
  profiles,
  value,
  inherit,
  onChange,
  label,
  className,
}: {
  agent: ChatAgent;
  profiles: readonly AgentProfile[];
  value: string | undefined;
  inherit?: string;
  onChange: (id: string | null) => void;
  /** What it is for, to a screen reader; the agent's name by default. */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const selected = value !== undefined ? profiles.find((p) => p.id === value) : undefined;
  return (
    <Select
      value={selected ? selected.id : INHERIT}
      onValueChange={(v) => onChange(v === INHERIT ? null : v)}
    >
      <SelectTrigger ariaLabel={label ?? AGENT_NAMES[agent]} className={cn("h-7 w-40", className)}>
        <SelectValue>
          {selected ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <ProfileDot color={selected.color} />
              <span className="truncate">{profileName(selected, t)}</span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">{inherit}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {inherit !== undefined && <SelectItem value={INHERIT}>{inherit}</SelectItem>}
        {profiles.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <span className="flex items-center gap-1.5">
              <ProfileDot color={p.color} />
              {profileName(p, t)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
