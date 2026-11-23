import { create } from "zustand";

interface TaskUIState {
  newTaskParentId: string | null;
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
