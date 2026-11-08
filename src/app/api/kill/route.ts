import { deny } from "@/lib/guard";
import { setKillSwitch } from "@/lib/jobs";

export async function POST(request: Request) {
  const blocked = await deny(); if (blocked) return blocked;
  const { on } = await request.json().catch(() => ({}));
  await setKillSwitch(on === true);
  return Response.json({ kill_switch: on === true });
}
