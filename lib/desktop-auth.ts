import { timingSafeEqual } from "node:crypto";
/** Disabled by default. This credential is never a Pipeline or sync credential. */
export function authorizeDesktop(request: Request, expected: string | undefined): Response | null {
  if (!expected || expected.length < 32) return Response.json({ error: "桌面连接尚未配置。" }, { status: 503 });
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const left = new TextEncoder().encode(supplied), right = new TextEncoder().encode(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return Response.json({ error: "请重新连接桌面应用。" }, { status: 401 });
  return null;
}

export async function handleDesktopRequest(
  request: Request, expected: string | undefined, dispatch: () => Promise<Response>,
): Promise<Response> {
  let response = authorizeDesktop(request, expected);
  if (!response) {
    try { response = await dispatch(); }
    catch { response = Response.json({ error: "数据服务暂时不可用。" }, { status: 503 }); }
  }
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.delete("access-control-allow-origin");
  return new Response(response.body, { status: response.status, headers });
}
