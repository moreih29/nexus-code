import { useEffect, useState } from "react";
import type { NoteLinkEntry } from "../../../shared/notes/links";
import { notesApi } from "./api";

const NO_LINKS: NoteLinkEntry[] = [];

export function useNoteLinks(workspaceId: string, noteId: string, location: string | undefined) {
  const [saved, setSaved] = useState<{
    noteId: string;
    location: string;
    entries: NoteLinkEntry[];
  }>();
  useEffect(() => {
    if (!location) return;
    let alive = true;
    let revision = 0;
    const read = () => {
      const request = ++revision;
      void notesApi.links(workspaceId, noteId).then(
        (entries) => {
          if (alive && revision === request) setSaved({ noteId, location, entries });
        },
        () => {},
      );
    };
    const stop = notesApi.onLinksChanged((event) => {
      if (event.locationKey === location && event.noteId === noteId) read();
    });
    read();
    return () => {
      alive = false;
      stop();
    };
  }, [workspaceId, noteId, location]);
  return saved?.noteId === noteId && saved.location === location ? saved.entries : NO_LINKS;
}
