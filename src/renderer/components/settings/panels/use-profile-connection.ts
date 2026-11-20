import { useEffect, useMemo, useState } from "react";
import {
  type ConnectionKeyChange,
  ConnectionKeyChangeSchema,
  type ConnectionKeyStatus,
  type ConnectionModel,
  type ConnectionModelsResult,
  type ConnectionPreset,
  type ConnectionProbe,
  type ConnectionTestResult,
  type CustomConnection,
  connectionPreset,
  type DiscoveredModel,
  isLocalConnectionPreset,
  normalizeConnectionUrl,
  type ProfileConnection,
  ProfileConnectionSchema,
} from "../../../../shared/agent-profiles/connection";
import type { AgentProfile } from "../../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { ipcCallResult } from "../../../ipc/client";

interface ModelRow extends ConnectionModel {
  rowId: string;
}

function blankModel(): ModelRow {
  return { rowId: crypto.randomUUID(), id: "" };
}

function pairsText(pairs: Record<string, string> | undefined, separator: string): string {
  return Object.entries(pairs ?? {})
    .map(([name, value]) => name + separator + value)
    .join("\n");
}

function parsePairs(text: string, separator: ":" | "="): Record<string, string> | null {
  const pairs: [string, string][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(separator);
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (at < 1 || !name || name.length > 128 || value.length > 4096) return null;
    if (separator === ":") {
      try {
        new Headers([[name, value]]);
      } catch {
        return null;
      }
    }
    pairs.push([name, value]);
  }
  return Object.fromEntries(pairs);
}

function normalizedAddress(agent: ChatAgent, address: string): string | undefined {
  try {
    return normalizeConnectionUrl(agent, address);
  } catch {
    return undefined;
  }
}

export function useProfileConnection(agent: ChatAgent, profile: AgentProfile | null) {
  const original = profile?.connection;
  const originalCustom = original?.method === "custom" ? original : undefined;
  const [method, setMethod] = useState<ProfileConnection["method"]>(original?.method ?? "account");
  const [baseUrl, setBaseUrl] = useState(originalCustom?.baseUrl ?? "");
  const [discoveryAddress, setDiscoveryAddress] = useState(() =>
    normalizedAddress(agent, originalCustom?.baseUrl ?? ""),
  );
  const [auth, setAuth] = useState<NonNullable<CustomConnection["auth"]>>(
    originalCustom?.auth ?? "bearer",
  );
  const [preset, setPreset] = useState(originalCustom?.preset);
  const [key, setKey] = useState<ConnectionKeyChange | undefined>();
  const [keyStatus, setKeyStatus] = useState<ConnectionKeyStatus>();
  const profileId = profile?.id;
  useEffect(() => {
    let active = true;
    void ipcCallResult("agentProfiles", "connectionKeyStatus", { profileId }).then((result) => {
      if (active && result.ok) setKeyStatus(result.value);
    });
    return () => {
      active = false;
    };
  }, [profileId]);

  const [rows, setRows] = useState<ModelRow[]>(
    () => originalCustom?.models.map((model) => ({ ...model, rowId: model.id })) ?? [blankModel()],
  );
  const [defaultRowId, setDefaultRowId] = useState(originalCustom?.defaultModel);
  const [lightRowId, setLightRowId] = useState(originalCustom?.lightModel);
  const [contextWindow, setContextWindow] = useState(originalCustom?.contextWindow);
  const [headersText, setHeadersText] = useState(
    pairsText(originalCustom?.advanced?.headers, ": "),
  );
  const [queryText, setQueryText] = useState(pairsText(originalCustom?.advanced?.query, "="));
  const [advanced, setAdvanced] = useState<
    Omit<NonNullable<CustomConnection["advanced"]>, "headers" | "query">
  >(originalCustom?.advanced ?? {});
  const headers = useMemo(() => parsePairs(headersText, ":"), [headersText]);
  const query = useMemo(() => parsePairs(queryText, "="), [queryText]);
  const address = normalizedAddress(agent, baseUrl);
  const keepSavedKey =
    method === original?.method &&
    (method !== "custom" ||
      (address === normalizedAddress(agent, originalCustom?.baseUrl ?? "") &&
        (agent === "codex" || auth === (originalCustom?.auth ?? "bearer"))));
  const keyPlaceholder =
    keepSavedKey && key === undefined && keyStatus?.present
      ? `••••••••${keyStatus.last4 ?? ""}`
      : undefined;
  const keyValid = key === undefined || ConnectionKeyChangeSchema.safeParse(key).success;
  const probe = useMemo<ConnectionProbe | undefined>(
    () =>
      method === "custom" && address && keyValid && headers && query
        ? { agent, baseUrl: address, auth, preset, profileId, key, headers, query }
        : undefined,
    [method, address, agent, auth, preset, profileId, key, keyValid, headers, query],
  );

  // Wait until the address field is confirmed before sending a draft key to it.
  const discoveryProbe = probe?.baseUrl === discoveryAddress ? probe : undefined;
  const [discovery, setDiscovery] = useState<ConnectionModelsResult>();
  const [looking, setLooking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const isLocal = isLocalConnectionPreset(preset);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry repeats the same discovery request.
  useEffect(() => {
    const probe = discoveryProbe;
    setDiscovery(undefined);
    setLooking(false);
    if (!probe) return;
    let active = true;
    const timer = setTimeout(() => {
      setLooking(true);
      void ipcCallResult("agentProfiles", "connectionDiscover", probe).then((result) => {
        if (!active) return;
        setLooking(false);
        const reply: ConnectionModelsResult = result.ok
          ? result.value
          : { ok: false, reason: "network" };
        setDiscovery(reply);
        const model =
          isLocal && reply.ok && reply.models.length === 1 ? reply.models[0] : undefined;
        if (model) {
          setRows((current) => {
            const populated = current.filter(({ id }) => id);
            if (populated.length > 0) return current;
            return [{ ...model, rowId: current[0]?.rowId ?? crypto.randomUUID() }];
          });
          if (agent === "claude" && model.contextWindow)
            setContextWindow((current) => current ?? model.contextWindow);
        }
      });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [discoveryProbe, attempt, agent, isLocal]);

  const chosen = rows.find(({ rowId }) => rowId === defaultRowId) ?? rows[0];
  const defaultModel = chosen?.id.trim() || undefined;
  const lightModel = rows.find(({ rowId }) => rowId === lightRowId)?.id.trim() || undefined;
  const models = rows.map(({ id, label, contextWindow: context, reasoning }) => ({
    id: id.trim(),
    label: label?.trim() || undefined,
    contextWindow: context,
    reasoning,
  }));
  const next = ProfileConnectionSchema.safeParse(
    method === "custom"
      ? {
          method,
          baseUrl: address,
          auth,
          preset,
          models,
          defaultModel,
          lightModel,
          contextWindow,
          advanced: {
            ...(agent === "claude"
              ? {
                  timeoutMs: advanced.timeoutMs,
                  maxOutputTokens: advanced.maxOutputTokens,
                  disableExperimentalBetas: advanced.disableExperimentalBetas,
                }
              : { retries: advanced.retries, streamIdleTimeoutMs: advanced.streamIdleTimeoutMs }),
            headers: headers && Object.keys(headers).length ? headers : undefined,
            query: agent === "codex" && query && Object.keys(query).length ? query : undefined,
          },
        }
      : { method },
  );
  const valid =
    next.success &&
    (method === "account" || keyValid) &&
    (method !== "api-key" || key === null || !!key || !!keyPlaceholder) &&
    (method !== "custom" ||
      (headers !== null &&
        query !== null &&
        new Set(models.map(({ id }) => id)).size === models.length));
  const [testResult, setTestResult] = useState<{
    probe: ConnectionProbe;
    model: string;
    value: ConnectionTestResult;
  }>();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    if (!probe || !defaultModel || testing) return;
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await ipcCallResult("agentProfiles", "connectionTest", {
        ...probe,
        model: defaultModel,
      });
      setTestResult({
        probe,
        model: defaultModel,
        value: result.ok ? result.value : { ok: false, reason: "network" },
      });
    } finally {
      setTesting(false);
    }
  };

  const changeMethod = (value: ProfileConnection["method"]) => {
    setMethod(value);
    setKey(undefined);
  };
  const choosePreset = (value: ConnectionPreset | undefined) => {
    setPreset(value);
    if (!value) {
      setBaseUrl("");
      setDiscoveryAddress(undefined);
      setKey(undefined);
      return;
    }
    const selected = connectionPreset(agent, value);
    setBaseUrl(selected.baseUrl);
    setDiscoveryAddress(
      value === "litellm" ? undefined : normalizedAddress(agent, selected.baseUrl),
    );
    setAuth(selected.auth);
    if (value !== preset || address !== selected.baseUrl) {
      setRows([blankModel()]);
      setDefaultRowId(undefined);
      setLightRowId(undefined);
      setContextWindow(undefined);
    }
    setKey(isLocalConnectionPreset(value) ? null : undefined);
    setAttempt((n) => n + 1);
  };
  const updateModel = (rowId: string, patch: Partial<ConnectionModel>) =>
    setRows((current) => current.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
  const removeModel = (rowId: string) =>
    setRows((current) =>
      current.length === 1 ? [blankModel()] : current.filter((row) => row.rowId !== rowId),
    );
  const toggleDiscovered = (model: DiscoveredModel) => {
    const row = rows.find(({ id }) => id === model.id);
    if (row) {
      removeModel(row.rowId);
      return;
    }
    setRows((current) =>
      current.length >= 128
        ? current
        : [
            ...current.filter(({ id }) => id),
            {
              id: model.id,
              label: model.label,
              contextWindow: model.contextWindow,
              rowId: crypto.randomUUID(),
            },
          ],
    );
  };

  return {
    method,
    changeMethod,
    baseUrl,
    setBaseUrl,
    confirmAddress: () => setDiscoveryAddress(address),
    address,
    auth,
    setAuth,
    preset,
    choosePreset,
    isLocal,
    key,
    setKey,
    keyValid,
    keyStatus,
    keyPlaceholder,
    rows,
    defaultRowId: chosen?.rowId,
    setDefaultRowId,
    lightRowId,
    setLightRowId,
    contextWindow,
    setContextWindow,
    headers,
    headersText,
    setHeadersText,
    query,
    queryText,
    setQueryText,
    advanced,
    setAdvanced,
    discovery,
    looking,
    updateModel,
    removeModel,
    toggleDiscovered,
    connection: next.data,
    valid,
    test,
    testing,
    canTest: Boolean(probe && defaultModel),
    testResult:
      testResult?.probe === probe && testResult?.model === defaultModel
        ? testResult?.value
        : undefined,
    defaultModel,
    defaultModelLabel: defaultModel ? chosen?.label?.trim() || defaultModel : undefined,
    findModels: () => {
      setDiscoveryAddress(address);
      setAttempt((n) => n + 1);
    },
    addModel: () => setRows((current) => [...current, blankModel()]),
  };
}

export type ProfileConnectionDraft = ReturnType<typeof useProfileConnection>;
