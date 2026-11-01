// src/renderer/state/stores/task-ui.ts — New-task and remove-task dialog state.
//
// A dedicated store (mirrors `useAddWorkspaceUIStore`) so that the title-bar
// task switcher and the `task.new` command drive the same dialogs.

import { create } from "zustand";

interface TaskUIState {
  /** The workspace the New Task dialog makes a task of; null while closed. */
  newTaskParentId: string | null;
  /** The task the Remove Task dialog removes; null while closed. */
  removeTaskId: string | null;
  openNewTask(parentId: string): void;
  closeNewTask(): void;
  openRemoveTask(taskId: string): void;
  closeRemoveTask(): void;
}

export const useTaskUIStore = create<TaskUIState>((set) => ({
  newTaskParentId: null,
  removeTaskId: null,

  openNewTask(parentId) {
    set({ newTaskParentId: parentId });
  },

  closeNewTask() {
    set({ newTaskParentId: null });
  },

  openRemoveTask(taskId) {
    set({ removeTaskId: taskId });
  },

  closeRemoveTask() {
    set({ removeTaskId: null });
  },
}));
