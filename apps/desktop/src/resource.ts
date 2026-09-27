import { useEffect, useState } from "react";
import { apiJson } from "@/packages/client/src/platform";
import { useDataRevision } from "@/packages/client/src/refresh";
export function useResource<T>(path: string) {
  const revision = useDataRevision();
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    void apiJson<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data });
    }).catch(error => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : "更新失败。" }));
    });
    return () => controller.abort();
  }, [path, revision]);
  return state;
}
