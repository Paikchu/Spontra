import { LocalizedText } from "../language-provider";
import { DailyReportsHome } from "../daily-reports-home";
import "../daily-reports-home.css";

export default function ChatPage() {
  return <>
    <a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
    <main className="page-shell" id="main-content"><DailyReportsHome /></main>
  </>;
}
