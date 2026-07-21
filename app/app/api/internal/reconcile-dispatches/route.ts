import { dispatchPending } from "@facereel/dispatch";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (
    request.headers.get("authorization") !==
      `Bearer ${process.env.CRON_SECRET}` ||
    !process.env.CRON_SECRET
  )
    return Response.json({ error: "Not authorized" }, { status: 401 });
  return Response.json(await dispatchPending(50));
}
