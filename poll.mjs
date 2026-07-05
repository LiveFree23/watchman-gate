// ============================================================================
//  THE WATCHMAN — The Gate poller
//  Runs on a schedule (GitHub Actions). For each watched inbox: connect
//  READ-ONLY over IMAP, read only envelopes (never the body), drop obvious
//  junk with plain rules, hand the rest to Claude Haiku to judge importance,
//  and write flagged mail into `triage_queue` as `pending`.
//
//  Passwords are NEVER in this file — they come from GitHub secrets by name.
//  The inbox is never modified; your mail app keeps the real copy.
// ============================================================================

import { ImapFlow } from "imapflow";
import { createClient } from "@supabase/supabase-js";

// ── which inboxes to watch ──────────────────────────────────────────────────
// `passEnv` is the NAME of the GitHub secret holding that mailbox's password.
const ACCOUNTS = [
  { host: "mail.notoriouslyfree.com", port: 993, user: "aaron@notoriouslyfree.com", passEnv: "IMAP_PW_LF", brand: "LIVE FREE" },
  { host: "mail.thealteredlife.org",  port: 993, user: "info@thealteredlife.org",   passEnv: "IMAP_PW_AL", brand: "ALTERED LIFE" },
  { host: "imap.ionos.com",           port: 993, user: "Aaron@cedarpoint.church",   passEnv: "IMAP_PW_CP", brand: "CEDAR POINT" },
];

// How far back to look each run, and a safety cap on classifier calls per inbox.
const LOOKBACK_HOURS = 48;
const MAX_CLASSIFY_PER_INBOX = 40;
const HAIKU_MODEL = "claude-haiku-4-5-20251001"; // easy to change if the id moves

// ── clients ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = need("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = need("SUPABASE_SERVICE_KEY");
const ANTHROPIC_API_KEY = need("ANTHROPIC_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required secret: ${name}`);
    process.exit(1);
  }
  return v;
}

// ── junk pre-filter (free — keeps obvious noise away from the classifier) ────
function isObviousJunk(fromAddr, headerText) {
  const h = (headerText || "").toLowerCase();
  if (h.includes("list-unsubscribe")) return true;
  if (h.includes("precedence: bulk") || h.includes("precedence: list")) return true;
  if (h.includes("auto-submitted:") && !h.includes("auto-submitted: no")) return true;
  const a = (fromAddr || "").toLowerCase();
  if (/(no[-_.]?reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce|notification)/.test(a)) return true;
  return false;
}

// ── the classifier ──────────────────────────────────────────────────────────
const TRIAGE_SYSTEM = `You are the triage gate for Aaron Shaw's ministry email across Live Free Ministries, Cedar Point Recovery, and The Altered Life. You see only the sender and subject of a single email — never the body.

Decide whether it needs Aaron to personally DO something: reply, make a decision, pay or approve, schedule, confirm, or show up. Newsletters, marketing, receipts, routine FYIs, and automated notifications are NOT important.

Respond with ONLY a JSON object — no prose, no code fences:
{"important": true, "reason": "<=8 words", "suggested_title": "short action-oriented task", "priority": "high"}

priority: high = money, a deadline, or someone waiting on him; med = needs action, no rush; low = minor. If it's not important, return the same shape with "important": false.`;

async function classify(fromStr, subject) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 200,
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: `From: ${fromStr}\nSubject: ${subject || "(no subject)"}` }],
    }),
  });
  if (!res.ok) {
    console.error("  Haiku error", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const jsonStr = text.replace(/```json|```/g, "").trim();
  const start = jsonStr.indexOf("{");
  const end = jsonStr.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(jsonStr.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ── sweep one inbox ─────────────────────────────────────────────────────────
async function sweep(acct) {
  const pass = process.env[acct.passEnv];
  if (!pass) {
    console.error(`  ! no password secret ${acct.passEnv} — skipping ${acct.user}`);
    return;
  }
  const client = new ImapFlow({
    host: acct.host,
    port: acct.port,
    secure: true,
    auth: { user: acct.user, pass },
    logger: false,
  });

  await client.connect();
  try {
    await client.mailboxOpen("INBOX", { readOnly: true }); // never modifies the mailbox
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) {
      console.log(`  ${acct.user}: nothing recent`);
      return;
    }

    // Pull envelopes + a few headers only — no body is ever fetched.
    const candidates = [];
    for await (const msg of client.fetch(
      uids,
      { uid: true, envelope: true, headers: ["list-unsubscribe", "precedence", "auto-submitted"] },
      { uid: true }
    )) {
      const env = msg.envelope || {};
      const fromObj = (env.from && env.from[0]) || {};
      const fromAddr = fromObj.address || "";
      const fromName = fromObj.name || fromAddr;
      const headerText = msg.headers ? msg.headers.toString() : "";
      const messageId = env.messageId || `${acct.user}:${msg.uid}`;
      if (isObviousJunk(fromAddr, headerText)) continue;
      candidates.push({
        messageId,
        fromName,
        fromAddr,
        subject: env.subject || "",
        date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
      });
    }

    if (candidates.length === 0) {
      console.log(`  ${acct.user}: all recent mail pre-filtered as noise`);
      return;
    }

    // Skip anything already in the Gate or already turned into a task.
    const ids = candidates.map((c) => c.messageId);
    const [{ data: inQueue }, { data: inTasks }] = await Promise.all([
      supabase.from("triage_queue").select("message_id").in("message_id", ids),
      supabase.from("tasks").select("from_message_id").in("from_message_id", ids),
    ]);
    const seen = new Set([
      ...(inQueue || []).map((r) => r.message_id),
      ...(inTasks || []).map((r) => r.from_message_id),
    ]);
    const fresh = candidates.filter((c) => !seen.has(c.messageId)).slice(0, MAX_CLASSIFY_PER_INBOX);

    let flagged = 0;
    for (const m of fresh) {
      const fromStr = m.fromName === m.fromAddr ? m.fromAddr : `${m.fromName} <${m.fromAddr}>`;
      const verdict = await classify(fromStr, m.subject);
      if (!verdict || !verdict.important) continue;
      const { error } = await supabase.from("triage_queue").insert({
        sender: m.fromName,
        sender_account: acct.user,
        subject: m.subject,
        message_id: m.messageId,
        reason: (verdict.reason || "Flagged by triage").slice(0, 200),
        suggested_title: (verdict.suggested_title || `Follow up: ${m.subject}`).slice(0, 200),
        suggested_brand: acct.brand,
        suggested_priority: ["high", "med", "low"].includes(verdict.priority) ? verdict.priority : "med",
        received_at: m.date,
        status: "pending",
      });
      if (error) console.error("  insert error", error.message);
      else flagged++;
    }
    console.log(`  ${acct.user}: ${candidates.length} looked at, ${fresh.length} new, ${flagged} flagged to the Gate`);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── run all inboxes; one failure never kills the others ─────────────────────
console.log(`Watchman sweep @ ${new Date().toISOString()}`);
for (const acct of ACCOUNTS) {
  try {
    await sweep(acct);
  } catch (e) {
    console.error(`  ! ${acct.user} failed:`, e.message);
  }
}
console.log("sweep complete");
