import { LocalizedText } from "../language-provider";
import { DailyReportsHome } from "../daily-reports-home";

export default function ChatPage() {
  return <>
    <a className="skip-link" href="#main-content"><LocalizedText>跳到主要内容</LocalizedText></a>
    <main className="page-shell page-shell-chat" id="main-content"><DailyReportsHome /></main>
  </>;
}
