import { timingSafeEqual } from "node:crypto";
import { pool } from "@/lib/db";
import { answerQuestion, createJob, parseJobUrl, setKillSwitch } from "@/lib/jobs";

// Telegram webhook. Set it once with setWebhook and secret_token=TELEGRAM_WEBHOOK_SECRET.
async function reply(chatId: number | string, text: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  }).catch(() => {});
}

function same(a: string, b: string) {
  return a.length === b.length && b.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: Request) {
  if (!same(request.headers.get("x-telegram-bot-api-secret-token") || "", process.env.TELEGRAM_WEBHOOK_SECRET || "")) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  const update = await request.json().catch(() => null);
  const chatId = String(update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? "");
  // Only the owner's chat may drive the agent.
  if (!same(chatId, process.env.TELEGRAM_CHAT_ID || "")) return Response.json({ ok: true });

  const cb = update.callback_query;
  if (cb) {
    const m = /^a:(\d+):(\d+)$/.exec(cb.data || "");
    if (m) {
      const q = (await pool.query("SELECT options FROM questions WHERE id=$1 AND answer IS NULL", [Number(m[1])])).rows[0];
      const choice = q?.options?.[Number(m[2])];
      if (choice !== undefined && await answerQuestion(Number(m[1]), String(choice))) await reply(chatId, `Got it: ${choice}`);
      else await reply(chatId, "That question is already answered or expired.");
    }
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: cb.id }),
    }).catch(() => {});
    return Response.json({ ok: true });
  }

  const text: string = (update.message?.text || "").trim();
  if (/^\/stop\b/.test(text)) { await setKillSwitch(true); await reply(chatId, "Stopped. All unfinished jobs are cancelled and new runs are blocked. Send /resume to allow runs again."); }
  else if (/^\/resume\b/.test(text)) { await setKillSwitch(false); await reply(chatId, "Runs are allowed again."); }
  else if (/^\/status\b/.test(text)) {
    const rows = (await pool.query("SELECT status, count(*)::int n FROM jobs GROUP BY status")).rows;
    await reply(chatId, rows.map(r => `${r.status}: ${r.n}`).join("\n") || "No jobs yet.");
  } else if (/^\/(apply|dry)\b|^https:\/\//i.test(text)) {
    const url = parseJobUrl(text.replace(/^\/(apply|dry)\s*/i, "").trim().split(/\s+/)[0]);
    if (!url) await reply(chatId, "Send an HTTPS job link.");
    else {
      try {
        const job = await createJob(url, /^\/dry/.test(text) ? "dry_run" : undefined);
        await reply(chatId, `Queued (${job.mode}). ${job.dispatched ? "Worker started." : "Worker could not be started; use Run now in the app."}`);
      } catch (error) { await reply(chatId, error instanceof Error ? error.message : "Could not queue."); }
    }
  } else if (text && !text.startsWith("/")) {
    const q = (await pool.query("SELECT id FROM questions WHERE answer IS NULL AND kind IN ('question','lesson') ORDER BY id DESC LIMIT 1")).rows[0];
    if (q && await answerQuestion(q.id, text.slice(0, 2000))) await reply(chatId, "Saved your answer.");
    else await reply(chatId, "Nothing is waiting for an answer. Send a job link to apply, /status, or /stop.");
  } else {
    await reply(chatId, "Commands: send a job link, /dry <link>, /status, /stop, /resume.");
  }
  return Response.json({ ok: true });
}
