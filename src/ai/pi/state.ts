/**
 * A session's recipe state as stored between tool calls. JSON with Maps and Sets kept as such; functions are dropped
 * and the host re-attaches them (`PiLoaded.hydrate`).
 */
export function packState(state: unknown): string {
  return JSON.stringify(state, (_key, value: unknown) => {
    if (value instanceof Map) return { __pi: "map", entries: [...value.entries()] };
    if (value instanceof Set) return { __pi: "set", values: [...value.values()] };
    if (typeof value === "function") return undefined;
    return value;
  });
}

export function unpackState<S>(text: string): S {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === "object" && "__pi" in value) {
      const tagged = value as { __pi: string; entries?: [unknown, unknown][]; values?: unknown[] };
      if (tagged.__pi === "map") return new Map(tagged.entries);
      if (tagged.__pi === "set") return new Set(tagged.values);
    }
    return value;
  }) as S;
}
