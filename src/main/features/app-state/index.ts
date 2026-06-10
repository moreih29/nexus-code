import { ipcContract } from "../../../shared/ipc/contract";
import type { AppState } from "../../../shared/types/app-state";
import { register, validateArgs } from "../../infra/ipc-router";
import type { StateService } from "../../infra/storage/state-service";

const c = ipcContract.appState.call;

export interface AppStateChannelOptions {
  /**
   * Invoked synchronously after a `set` call that includes a `language`
   * field, with the newly requested language value.
   *
   * The main/index.ts wiring uses this to:
   *   (a) call getMainI18n().changeLanguage(lang) so subsequent t() calls
   *       resolve to the new locale immediately;
   *   (b) reinstall the native application menu with the updated labels;
   *   (c) broadcast `appState.languageChanged` to all renderer windows.
   */
  onLanguageChanged?: (language: AppState["language"] & string) => void;
  /**
   * Invoked synchronously after a `set` call that includes a
   * `keybindingOverrides` field, with the new override list.
   *
   * The main/index.ts wiring uses this to:
   *   (a) reinstall the native application menu so accelerator labels
   *       reflect the effective bindings;
   *   (b) broadcast `appState.keybindingsChanged` to all renderer
   *       windows so each recompiles its dispatcher tables.
   */
  onKeybindingsChanged?: (overrides: NonNullable<AppState["keybindingOverrides"]>) => void;
  /**
   * Invoked synchronously after a `set` call that includes an
   * `editorKeybindingOverrides` field, with the new override list.
   *
   * The main/index.ts wiring uses this only to broadcast
   * `appState.editorKeybindingsChanged` to all renderer windows so each
   * re-reconciles Monaco. No native-menu rebuild — editor commands are
   * not menu items.
   */
  onEditorKeybindingsChanged?: (
    overrides: NonNullable<AppState["editorKeybindingOverrides"]>,
  ) => void;
}

export function registerAppStateChannel(
  stateService: StateService,
  opts: AppStateChannelOptions = {},
): void {
  register("appState", {
    call: {
      get: (_args: unknown) => {
        return stateService.getState();
      },
      set: (args: unknown) => {
        const patch = validateArgs(c.set.args, args);
        stateService.setState(patch);

        // Detect a language change and invoke the injected callback so the
        // caller can update the main-process i18n instance, rebuild the menu,
        // and broadcast to all renderer windows — without this module needing
        // to know about i18n, menus, or IPC broadcasting directly.
        if (patch.language !== undefined && opts.onLanguageChanged !== undefined) {
          opts.onLanguageChanged(patch.language);
        }

        // Same pattern for keybinding overrides: menu rebuild + broadcast
        // are owned by the caller so this module stays IPC-only.
        if (patch.keybindingOverrides !== undefined && opts.onKeybindingsChanged !== undefined) {
          opts.onKeybindingsChanged(patch.keybindingOverrides);
        }

        // Editor (Monaco) overrides: broadcast-only, no menu involvement.
        if (
          patch.editorKeybindingOverrides !== undefined &&
          opts.onEditorKeybindingsChanged !== undefined
        ) {
          opts.onEditorKeybindingsChanged(patch.editorKeybindingOverrides);
        }
      },
    },
    listen: {},
  });
}
