import { useStore } from "zustand";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import {
  type Command,
  type CommandGroup as CommandGroupName,
  keyboardRegistryStore,
} from "../stores/keyboard-registry";

interface CommandPaletteProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const COMMAND_GROUPS: CommandGroupName[] = ["Workspace", "View", "Terminal", "App"];

export function CommandPalette({ onOpenChange, open }: CommandPaletteProps) {
  const commands = useStore(keyboardRegistryStore, (state) => state.getCommands());
  const getBindingFor = useStore(keyboardRegistryStore, (state) => state.getBindingFor);
  const executeCommand = useStore(keyboardRegistryStore, (state) => state.executeCommand);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command..." />
      <CommandList>
        <CommandEmpty>No command found.</CommandEmpty>
        {COMMAND_GROUPS.map((group) => {
          const groupCommands = commands.filter((command) => command.group === group);

          if (groupCommands.length === 0) {
            return null;
          }

          return (
            <CommandGroup key={group} heading={group}>
              {groupCommands.map((command) => (
                <CommandPaletteItem
                  key={command.id}
                  command={command}
                  keychord={getBindingFor(command.id)}
                  onSelect={() => {
                    void executeCommand(command.id);
                    onOpenChange(false);
                  }}
                />
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

function CommandPaletteItem({
  command,
  keychord,
  onSelect,
}: {
  command: Command;
  keychord: string | null;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={`${command.group} ${command.title}`} onSelect={onSelect}>
      <span>{command.title}</span>
      {keychord ? <CommandShortcut>{keychord}</CommandShortcut> : null}
    </CommandItem>
  );
}
