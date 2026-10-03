import { redirect } from "next/navigation";
import { ADMIN_SITE_ORIGIN } from "@/shared/admin-site";
export const metadata = { title: "财报管理 · Spontra", robots: { index: false, follow: false } };
export default function ReportAdminPage() { redirect(`${ADMIN_SITE_ORIGIN}/admin/reports`); }
