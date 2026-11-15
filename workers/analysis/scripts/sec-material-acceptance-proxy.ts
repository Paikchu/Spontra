type ProxyEnv = { ANALYSIS: Fetcher };

export default {
  fetch(request: Request, env: ProxyEnv): Promise<Response> | Response {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.startsWith("/acceptance/")) return new Response("Not found", { status: 404 });
    url.hostname = "spontra-analysis.internal";
    url.pathname = url.pathname.replace(/^\/acceptance\//, "/admin/material-acceptance/");
    return env.ANALYSIS.fetch(new Request(url, request));
  },
};
