import { create } from "zustand";
import {
  DEFAULT_RECORDING_SUMMARY_SETTINGS,
  type RecordingSummarySettings,
} from "../../../shared/notes/summary";

export const useNoteSummarySettings = create<RecordingSummarySettings>(
  () => DEFAULT_RECORDING_SUMMARY_SETTINGS,
);
