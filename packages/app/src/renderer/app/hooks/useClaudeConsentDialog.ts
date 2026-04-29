import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ClaudeSettingsConsentRequest } from "../../../../../shared/src/contracts/claude/claude-settings";

export interface ClaudeConsentDialogState {
  request: ClaudeSettingsConsentRequest | null;
  dontAskAgain: {
    checked: boolean;
    set(checked: boolean): void;
  };
  complete(approved: boolean, dontAskAgain?: boolean): void;
  dismiss(): void;
}

export function useClaudeConsentDialog(): ClaudeConsentDialogState {
  const [request, setRequest] = useState<ClaudeSettingsConsentRequest | null>(null);
  const [dontAskAgain, setDontAskAgainState] = useState(false);
  const pendingRequestRef = useRef<ClaudeSettingsConsentRequest | null>(null);
  const dontAskAgainRef = useRef(false);

  const setDontAskAgain = useCallback((checked: boolean) => {
    dontAskAgainRef.current = checked;
    setDontAskAgainState(checked);
  }, []);

  const complete = useCallback((approved: boolean, nextDontAskAgain = dontAskAgainRef.current) => {
    const pendingRequest = pendingRequestRef.current;
    if (!pendingRequest) {
      return;
    }

    pendingRequestRef.current = null;
    setRequest(null);
    setDontAskAgain(false);
    void window.nexusClaudeSettings.respondConsentRequest({
      requestId: pendingRequest.requestId,
      approved,
      dontAskAgain: approved ? nextDontAskAgain : false,
    }).catch((error) => {
      console.error("Claude settings consent: failed to send decision.", error);
    });
  }, [setDontAskAgain]);

  const dismiss = useCallback(() => {
    complete(false, false);
  }, [complete]);

  useEffect(() => {
    const subscription = window.nexusClaudeSettings.onConsentRequest((nextRequest) => {
      if (pendingRequestRef.current) {
        complete(false, false);
      }

      pendingRequestRef.current = nextRequest;
      setDontAskAgain(false);
      setRequest(nextRequest);
    });

    return () => {
      subscription.dispose();
      dismiss();
    };
  }, [complete, dismiss]);

  return useMemo(() => ({
    request,
    dontAskAgain: {
      checked: dontAskAgain,
      set: setDontAskAgain,
    },
    complete,
    dismiss,
  }), [complete, dismiss, dontAskAgain, request, setDontAskAgain]);
}
