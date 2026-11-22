import { AboutPanel } from "./panels/about-panel";
import { AgentInstructionsPanel } from "./panels/agent-instructions-panel";
import { AgentPanel } from "./panels/agent-panel";
import { AgentProfilesPanel } from "./panels/agent-profiles-panel";
import { AppearancePanel } from "./panels/appearance-panel";
import { BrowserPermissionsPanel } from "./panels/browser-permissions-panel";
import { EditorPanel } from "./panels/editor-panel";
import { KeybindingsPanel } from "./panels/keybindings-panel";
import { LanguageServersPanel } from "./panels/language-servers-panel";
import { NotesPanel } from "./panels/notes-panel";
import { NotificationsPanel } from "./panels/notifications-panel";
import { ProfileRulesPanel } from "./panels/profile-rules-panel";
import { RemotePanel } from "./panels/remote-panel";
import { TerminalPanel } from "./panels/terminal-panel";

export function SettingsPanels({ activeId, go }: { activeId: string; go: (id: string) => void }) {
  if (activeId === "appearance") return <AppearancePanel />;
  if (activeId === "editor") return <EditorPanel />;
  if (activeId === "language-servers") return <LanguageServersPanel />;
  if (activeId === "terminal") return <TerminalPanel />;
  if (activeId === "notifications") return <NotificationsPanel />;
  if (activeId === "notes") return <NotesPanel />;
  if (activeId === "agent") return <AgentPanel />;
  if (activeId === "claude") return <AgentProfilesPanel agent="claude" onNavigate={go} />;
  if (activeId === "codex") return <AgentProfilesPanel agent="codex" onNavigate={go} />;
  if (activeId === "profile-rules") return <ProfileRulesPanel />;
  if (activeId === "instructions") return <AgentInstructionsPanel />;
  if (activeId === "remote") return <RemotePanel />;
  if (activeId === "browser-permissions") return <BrowserPermissionsPanel />;
  if (activeId === "keybindings") return <KeybindingsPanel />;
  if (activeId === "about") return <AboutPanel />;
  return null;
}
