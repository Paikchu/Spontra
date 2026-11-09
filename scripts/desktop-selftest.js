/*
 * Runs inside the real webview of a `selftest` build, before the page's own scripts. It drives the page the way a reader
 * would and reports each check over IPC. `scripts/desktop-selftest.ts` starts the app and collects the results.
 */
(() => {
  if (window !== window.top) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const report = (name, ok, detail) => invoke("selftest_report", { line: JSON.stringify({ name, ok, detail }) });
  const problems = [];
  // zod probes for eval once and handles the refusal; the site reports the same.
  addEventListener("securitypolicyviolation", e => { if (e.blockedURI !== "eval") problems.push(`csp ${e.violatedDirective} ${e.blockedURI}`); });
  addEventListener("error", e => problems.push(`error ${e.message}`));
  addEventListener("unhandledrejection", e => problems.push(`rejection ${e.reason}`));
  const sockets = [];
  window.WebSocket = new Proxy(window.WebSocket, { construct(target, args) { sockets.push(String(args[0])); return new target(...args); } });

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (test, timeout = 20000) => { const start = performance.now(); for (;;) { const value = test(); if (value) return value; if (performance.now() - start > timeout) return null; await sleep(40); } };
  const $ = selector => document.querySelector(selector);
  const CHART = ".fc-svg, .fc-compact-node";
  const key = (k, extra = {}) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, ...extra }));
  const clean = () => problems.filter(p => !p.includes("ResizeObserver"));
  const goTo = path => { history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); };
  const check = async (name, body) => { try { const { ok, detail } = await body(); await report(name, !!ok, detail); } catch (error) { await report(name, false, String(error)); } };

  async function door() {
    const identity = await fetch("/agents/identity", { method: "POST" });
    const token = await invoke("reader_token");
    await report("proxy-identity", identity.ok && !!token, { status: identity.status, token: !!token });
    const id = "0".repeat(32);
    const site = window.__selftest_site;
    for (const [name, query] of [["door-with-reader", `?reader=${encodeURIComponent(token)}`], ["door-without-reader", ""]]) {
      const heard = await new Promise(resolve => {
        const socket = new WebSocket(`${site}/agents/stage-agent/${id}${query}`);
        socket.onmessage = event => { resolve(JSON.parse(event.data)); socket.close(); };
        socket.onerror = () => resolve({ failed: true });
        setTimeout(() => resolve({ timeout: true }), 8000);
      });
      await report(name, query ? heard.token === token && !heard.url.includes("reader=") : !heard.failed && !heard.token, heard);
    }
    await report("problems", clean().length === 0, clean());
    await report("done", true);
  }

  async function full() {
    if (location.pathname !== "/") goTo("/");
    const rows = await until(() => document.querySelectorAll(".home-table tbody tr:not(.home-ghost) a.home-row-link").length);
    await report("home-lists-companies", rows > 0, { rows });
    await check("reads-come-through-the-proxy", async () => {
      const response = await fetch("/api/business/v1/home?lang=en");
      return { ok: response.ok && (await response.json()) && response.headers.get("x-spontra-cache"), detail: response.headers.get("x-spontra-cache") };
    });
    await check("proxy-refuses-the-rest", async () => {
      const telemetry = await fetch("/api/business/v1/telemetry"), admin = await fetch("/agents/../admin/x").catch(() => null);
      return { ok: telemetry.status === 404, detail: { telemetry: telemetry.status, admin: admin?.status } };
    });
    await check("logos-load", async () => { const n = await until(() => [...document.querySelectorAll(".company-logo img")].filter(img => img.complete && img.naturalWidth > 0).length, 8000); return { ok: n, detail: { painted: n, sources: [...new Set([...document.querySelectorAll(".company-logo img")].map(img => img.src.split(":")[0]))] } }; });
    const links = [...document.querySelectorAll("a.home-row-link")];
    const first = links[0], second = links[1];
    const tickerOf = link => link.getAttribute("href").split("/").pop();
    first.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await sleep(1500);
    await check("hover-reads-ahead", async () => {
      const started = performance.now(), response = await fetch(`/api/business/v1/companies/${tickerOf(first)}/opening`), source = response.headers.get("x-spontra-cache");
      await response.arrayBuffer();
      return { ok: source !== "network", detail: { source, ms: Math.round(performance.now() - started) } };
    });
    const clicked = performance.now();
    first.click();
    const chart = await until(() => $(CHART));
    await report("company-opens", !!chart && location.pathname === `/companies/${tickerOf(first)}`, { path: location.pathname, ms: Math.round(performance.now() - clicked) });

    await check("window-chrome", async () => {
      await until(() => $(".rail-top[data-tauri-drag-region=deep]"), 3000);
      const rail = $(".rail").getBoundingClientRect(), head = $(".rail-top .company, .rail-top > *").getBoundingClientRect(), style = getComputedStyle($(".rail"));
      const scroller = $(".rail-scroll");
      const size = await invoke("plugin:window|inner_size", { label: "main" }), scale = await invoke("plugin:window|scale_factor", { label: "main" });
      const detail = { innerWidth, windowPoints: size.width / scale, railLeft: rail.left, railTop: rail.top, railBottom: Math.round(innerHeight - rail.bottom), radius: style.borderTopLeftRadius, headTop: Math.round(head.top), gutter: scroller.offsetWidth - scroller.clientWidth };
      return { ok: rail.left === 0 && rail.top === 0 && detail.railBottom === 0 && style.borderTopLeftRadius === "0px" && head.top >= 38 && detail.gutter === 0 && Math.abs(innerWidth * 0.9 - detail.windowPoints) < 3, detail };
    });
    await check("scroll-thumb-appears-and-fades", async () => {
      const scroller = [...document.querySelectorAll(".rail-scroll, .stage, .lens-doc")].find(e => e.scrollHeight > e.clientHeight + 40);
      if (!scroller) return { ok: true, detail: "nothing overflows at this size" };
      scroller.scrollTop = 40;
      const shown = await until(() => $(".desktop-scroll-thumb[data-visible]"), 1500);
      const faded = await until(() => !$(".desktop-scroll-thumb[data-visible]"), 2500);
      scroller.scrollTop = 0;
      return { ok: shown && faded, detail: { shown: !!shown, faded: !!faded } };
    });
    await check("view-shortcuts", async () => {
      const seen = {};
      for (const [digit, view] of [["2", "profit"], ["3", "cash"], ["4", "balance"], ["1", "valuation"], ["2", "profit"]]) {
        if (!$(`[data-view-choice="${view}"]`)) { seen[view] = "absent"; continue; }
        key(digit);
        seen[view] = !!(await until(() => $(`[data-view-choice="${view}"]`)?.getAttribute("aria-checked") === "true", 4000));
      }
      return { ok: Object.values(seen).every(v => v === true || v === "absent"), detail: seen };
    });
    await check("search-shortcut", async () => {
      key("k");
      const dialog = await until(() => $("dialog.search-dialog[open]") ?? $(".search-dialog[open]"), 3000);
      dialog?.close?.();
      await sleep(100);
      key("Escape", { metaKey: false });
      return { ok: dialog, detail: { opened: !!dialog } };
    });
    await check("theme-switch", async () => {
      const before = document.documentElement.classList.contains("light");
      $("[data-theme-toggle]").click();
      const flipped = await until(() => document.documentElement.classList.contains("light") !== before, 2000);
      $("[data-theme-toggle]").click();
      await until(() => document.documentElement.classList.contains("light") === before, 2000);
      return { ok: flipped, detail: { from: before ? "light" : "dark" } };
    });
    await check("chart-frame-loads", async () => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.src = "/lens-frame?lang=en";
      frame.style.cssText = "position:fixed;left:-9999px;width:300px;height:200px";
      let ready = false;
      const listener = event => { if (event.source === frame.contentWindow && event.origin === location.origin && event.data?.type === "lens:ready") ready = true; };
      addEventListener("message", listener);
      document.body.append(frame);
      await until(() => ready, 8000);
      removeEventListener("message", listener);
      frame.remove();
      return { ok: ready, detail: { ready } };
    });
    await check("picture-frame-sandbox", async () => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = "/html-frame.html";
      frame.style.cssText = "position:fixed;left:-9999px;width:300px;height:200px";
      const heard = {};
      const listener = event => { if (event.source !== frame.contentWindow || !event.data) return; if (event.data.type === "html:ready" && !heard.ready) { heard.ready = true; frame.contentWindow.postMessage({ type: "html:render", id: "t", html: `<div id="p"></div><script>fetch("https://example.com").then(()=>parent.postMessage({type:"probe",net:true},"*")).catch(()=>parent.postMessage({type:"probe",net:false},"*"))<\/script>`, theme: { scheme: "dark", tokens: {} }, font: "", lang: "en" }, "*"); } if (event.data.type === "html:rendered") heard.rendered = true; if (event.data.type === "probe") heard.net = event.data.net; };
      addEventListener("message", listener);
      document.body.append(frame);
      frame.addEventListener("load", () => frame.contentWindow.postMessage({ type: "html:ping" }, "*"));
      await until(() => heard.rendered && heard.net !== undefined, 8000);
      removeEventListener("message", listener);
      frame.remove();
      return { ok: heard.rendered && heard.net === false, detail: heard };
    });
    await check("external-links-leave-the-app", async () => {
      const link = Object.assign(document.createElement("a"), { href: "https://www.sec.gov/", target: "_blank", textContent: "x" });
      document.body.append(link); link.click(); link.remove();
      await sleep(200);
      return { ok: location.protocol !== "https:", detail: location.protocol };
    });
    await check("menu-commands", async () => {
      await invoke("install_menu", { locale: "en" });
      await invoke("plugin:event|emit", { event: "menu", payload: "home" });
      const home = await until(() => location.pathname === "/", 3000);
      return { ok: home, detail: location.pathname };
    });
    await check("stage-socket-address", async () => {
      await until(() => $(".home-table"), 5000);
      await sleep(1000);
      const opened = performance.now();
      goTo(`/companies/${tickerOf(first)}`);
      await until(() => $(CHART));
      await report("company-reopens", true, { ms: Math.round(performance.now() - opened) });
      const status = await fetch(`/agents/status?ticker=${tickerOf(first)}`).then(r => r.json());
      (await until(() => $(".ask-open"), 5000))?.click();
      const url = await until(() => sockets.find(s => s.includes("/agents/stage-agent/")), 12000);
      return { ok: status.open && url && url.startsWith("wss://") && /[?&]reader=a1\./.test(url), detail: { status, url: url?.replace(/reader=[^&]+/, "reader=<token>"), token: !!(await invoke("reader_token")) } };
    });
    await report("awaiting-deep-link", true, { ticker: tickerOf(second) });
    await check("deep-link-opens-the-company", async () => {
      const target = `/companies/${tickerOf(second)}`;
      const arrived = await until(() => location.pathname === target && location.search.includes("view=cash"), 15000);
      return { ok: arrived, detail: location.pathname + location.search };
    });
    await until(() => $(CHART));
    await report("problems-before-reload", clean().length === 0, clean());
    sessionStorage.setItem("selftest-phase", "reload");
    location.reload();
  }

  async function afterReload() {
    const chart = await until(() => $(CHART));
    await report("deep-address-survives-reload", !!chart, location.pathname + location.search);
    await report("problems", clean().length === 0, clean());
    sessionStorage.removeItem("selftest-phase");
    await report("done", true);
  }

  addEventListener("load", () => setTimeout(() => {
    const body = window.__selftest_mode === "door" ? door : sessionStorage.getItem("selftest-phase") === "reload" ? afterReload : full;
    body().catch(error => report("crashed", false, String(error)));
  }, 50));
})();
