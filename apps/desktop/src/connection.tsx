import { useState, type FormEvent } from "react";
import { connect, disconnect } from "./transport";
import { useLanguage } from "@/app/language-provider";
export function Connection({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { language } = useLanguage();
  const en = language === "en";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { await connect(token.trim()); setToken(""); onConnected(); }
    catch { setError(en ? "Connection failed. Check your token, network and server configuration." : "连接失败，请检查访问令牌、网络及服务端配置。"); }
    finally { setBusy(false); }
  }
  return <div className="desktop-connection" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <form onSubmit={submit} className="sp-card">
      <h1 id="connection-title">{en ? "Connect to Spontra" : "连接 Spontra"}</h1>
      <p>{en ? "Enter your desktop access token. It will be saved in your system credential store." : "输入桌面访问令牌，连接你的投资数据。令牌会保存在系统凭据库。"}</p>
      <label htmlFor="desktop-token">{en ? "Access token" : "访问令牌"}</label>
      <input id="desktop-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} required minLength={32} disabled={busy} />
      {error && <p role="alert">{error}</p>}
      <button className="sp-btn" disabled={busy || token.trim().length < 32}>{busy ? (en ? "Connecting…" : "连接中…") : (en ? "Connect" : "连接")}</button>
    </form>
  </div>;
}
export function ConnectionSettings({ onDisconnected }: { onDisconnected: () => void }) {
  const [error, setError] = useState("");
  const { language } = useLanguage(); const en = language === "en";
  return <section className="desktop-connection-settings"><h2>{en ? "Desktop connection" : "桌面连接"}</h2><p>Spontra 0.1.0 · {en ? "Manual updates" : "手动更新"}</p>
    <button className="sp-btn" onClick={() => { void disconnect().then(onDisconnected).catch(() => setError(en ? "Could not remove credential. Try again." : "凭据清除失败，请重试。")); }}>{en ? "Disconnect and remove token" : "断开连接并清除令牌"}</button>{error && <p role="alert">{error}</p>}
  </section>;
}
