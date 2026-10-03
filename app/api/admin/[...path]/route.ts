import { ADMIN_SITE_ORIGIN } from "@/shared/admin-site";
export const dynamic = "force-dynamic";
// Never redirect writes or forward an old host's cookies to the new host.
function moved() {
  return Response.json({ error: "管理后台已迁移，请从新入口重新登录。", adminUrl: `${ADMIN_SITE_ORIGIN}/admin/reports` }, {
    status: 410,
    headers: { "cache-control": "private, no-store", "set-cookie": "spontra_report_admin=; Path=/api/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=0" },
  });
}
export const GET = moved;
export const POST = moved;
export const DELETE = moved;
