import { redirect } from "next/navigation";

/** 群聊 now lives on Today. Keep old bookmarks working. */
export default function ChatPage() {
  redirect("/");
}
