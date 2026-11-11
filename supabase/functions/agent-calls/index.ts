// agent-calls v7 -- daily agent call block: recall wave + never-called fill,
// then CAMPAIGN rows appended at the BACK with their own message.
//   GET  ?data=1&k=<TOKEN>[&n=20][&r=10][&c=<campaign>]
//        -> { list, active_remaining, worked_total, recall_remaining, campaign_remaining }
//        Campaign rows ride behind the daily pull and are NOT capped by n.
//   POST { k, id, action, notes, message?, label? }  -> actions:
//        save_note | talked | follow_up | worked | no_answer | skip | dnc | untext | send_text
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TOKEN = Deno.env.get('AGENT_CALLS_TOKEN') ?? '';
const GHL_TOKEN = Deno.env.get('GHL_API_TOKEN') ?? Deno.env.get('GHL_API_KEY') ?? Deno.env.get('GHL_TOKEN') ?? '';
const GHL_LOC = Deno.env.get('GHL_LOCATION_ID') ?? 'ERorIDfOTkbtiJ9fX0lr';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_H = { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const last10 = (s: string) => { const d = (s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };

async function countOf(qs: string): Promise<number> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/agent_call_queue?${qs}`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } });
    const n = (r.headers.get('content-range') || '').split('/')[1];
    return n ? parseInt(n, 10) : 0;
  } catch { return 0; }
}

async function ghlResolve(phone: string, name: string): Promise<string | null> {
  const p = last10(phone);
  if (!GHL_TOKEN || p.length < 10) return null;
  let id: string | null = null;
  try {
    const r = await fetch(`${GHL_BASE}/contacts/?locationId=${GHL_LOC}&query=${p}`, { headers: GHL_H });
    if (r.ok) { const d = await r.json(); const c = (d.contacts || []).find((c: { phone?: string }) => last10(c.phone || '') === p); if (c?.id) id = c.id; }
  } catch { /* */ }
  if (!id) {
    const clean = (name || '').replace(/^\s*[^-]*-\s*/, '').trim() || 'Agent';
    const parts = clean.split(/\s+/);
    try {
      const r = await fetch(`${GHL_BASE}/contacts/`, { method: 'POST', headers: GHL_H, body: JSON.stringify({ locationId: GHL_LOC, firstName: parts[0] || 'Agent', lastName: parts.slice(1).join(' ') || '', phone: p, tags: ['agent partner'] }) });
      if (r.ok) { const d = await r.json(); id = d?.contact?.id ?? d?.id ?? null; }
    } catch { /* */ }
  }
  return id;
}
async function ghlNote(id: string, body: string): Promise<void> {
  try { await fetch(`${GHL_BASE}/contacts/${id}/notes`, { method: 'POST', headers: GHL_H, body: JSON.stringify({ body: body.slice(0, 4000) }) }); } catch { /* */ }
}
async function ghlSend(id: string, message: string): Promise<{ ok: boolean; reason?: string; messageId?: string; uncertain?: boolean }> {
  try {
    const r = await fetch(`${GHL_BASE}/conversations/messages`, { method: 'POST', headers: GHL_H, body: JSON.stringify({ type: 'SMS', contactId: id, message }) });
    if (r.ok) {
      const receipt = await r.json().catch(() => ({}));
      return { ok: true, messageId: receipt.messageId ?? undefined };
    }
    const t = (await r.text()).slice(0, 300);
    let reason = 'GHL could not send';
    if (/DND/i.test(t)) reason = 'Agent is on Do Not Disturb / opted out';
    else if (/no valid|provider|number/i.test(t)) reason = 'No SMS number set up in GHL';
    return { ok: false, reason, uncertain: r.status >= 500 };
  } catch { return { ok: false, reason: 'send error', uncertain: true }; }
}
async function ghlLog(phone: string, name: string, body: string): Promise<string> {
  const id = await ghlResolve(phone, name);
  if (!id) return 'no-contact';
  await ghlNote(id, body);
  return 'noted';
}
async function markQueue(id: number, action: string, notes: string, tracked = false): Promise<boolean> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/${tracked ? 'agent_outreach_mark' : 'agent_call_mark'}`, { method: 'POST', headers: H, body: JSON.stringify({ p_id: id, p_action: action, p_notes: notes }) });
    return r.ok;
  } catch { return false; }
}
// Once a campaign agent is handled, clear the flag so they drop out of the back block.
async function clearCampaign(id: number): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/agent_call_queue?id=eq.${id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ campaign: null, campaign_message: null }) });
  } catch { /* */ }
}

const LABELS: Record<string, string> = {
  save_note: 'Note added',
  talked: 'Spoke with them',
  follow_up: 'Follow-up needed',
  worked: 'Texted ✓',
  no_answer: 'No answer',
  skip: 'Skipped',
  dnc: 'Do not call',
};
const CLEARS = ['worked', 'skip', 'dnc', 'send_text'];

async function activityRpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: H, body: JSON.stringify(args)
  });
  if (!response.ok) throw new Error('Activity database request failed');
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function activityAccess(token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const response = await fetch(`${SB_URL}/functions/v1/gate?verify=${encodeURIComponent(token)}`);
  if (!response.ok) return false;
  return (await response.json()).ok === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);

  if (req.method === 'POST') {
    let b: Record<string, unknown> = {};
    try { b = await req.json(); } catch { /* */ }
    if ((b.k ?? '') !== TOKEN || !TOKEN) return json({ ok: false, error: 'unauthorized' }, 401);
    const id = Number(b.id);
    const action = (b.action ?? '').toString();
    const notes = (b.notes ?? '').toString().trim();
    const label = (b.label ?? '').toString().trim().slice(0, 80);
    const tracked = b.activity_version === 1;
    const requestId = String(b.request_id ?? '');
    if (tracked && !(await activityAccess(b.session).catch(() => false))) {
      return json({ ok: false, error: 'Sign in again to track activity' }, 401);
    }
    if (tracked && action === 'activity_report') {
      const from = String(b.from ?? '');
      const to = String(b.to ?? '');
      const date = /^\d{4}-\d{2}-\d{2}$/;
      if (!date.test(from) || !date.test(to) || from > to) {
        return json({ ok: false, error: 'Select a valid date range' }, 400);
      }
      try {
        return json({ ok: true, report: await activityRpc('agent_outreach_report', { p_from: from, p_to: to }) });
      } catch {
        return json({ ok: false, error: 'Report unavailable' }, 503);
      }
    }
    const isRecord = action === 'log_call' || action === 'log_phone_text';
    if (tracked && (isRecord || action === 'send_text') &&
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) {
      return json({ ok: false, error: 'Missing activity request ID' }, 400);
    }
    if (tracked && isRecord && Number.isSafeInteger(id) && id > 0) {
      try {
        await activityRpc('agent_outreach_record', {
          p_id: id, p_request: requestId, p_kind: action === 'log_call' ? 'call' : 'phone_text'
        });
        return json({ ok: true });
      } catch {
        return json({ ok: false, error: 'Activity could not be recorded. Retry the same action.' }, 503);
      }
    }
    const allowed = ['save_note', 'talked', 'follow_up', 'worked', 'no_answer', 'skip', 'dnc', 'untext', 'send_text', ...(tracked ? ['finish'] : [])];
    if (!id || !allowed.includes(action)) return json({ ok: false, error: 'bad request', allowed }, 400);
    if (action === 'save_note' && !notes) return json({ ok: false, error: 'note is empty' }, 400);

    let row: { phone10?: string; contact_name?: string; phone_display?: string } | null = null;
    try {
      const r = await fetch(`${SB_URL}/rest/v1/agent_call_queue?id=eq.${id}&select=phone10,phone_display,contact_name`, { headers: H });
      if (r.ok) { const j = await r.json(); row = j[0] ?? null; }
    } catch { /* */ }

    if (action === 'send_text') {
      const message = (b.message ?? '').toString();
      if (!message) return json({ ok: false, error: 'no message' }, 400);
      const cid = await ghlResolve(row?.phone10 || row?.phone_display || '', row?.contact_name || '');
      if (!cid) return json({ ok: true, sent: false, reason: 'No GHL contact / phone for this agent' });
      if (tracked) {
        try {
          const claim = await activityRpc('agent_outreach_record', {
            p_id: id, p_request: requestId, p_kind: 'ghl_text'
          });
          if (!claim.created) return json({
            ok: true, sent: claim.state === 'accepted', uncertain: ['pending', 'unknown'].includes(claim.state)
          });
        } catch {
          return json({ ok: false, sent: false, uncertain: true, reason: 'SMS tracking unavailable. Check GHL before trying again.' }, 503);
        }
      }
      const s = await ghlSend(cid, message);
      if (tracked) {
        try {
          await activityRpc('agent_outreach_finish', {
            p_request: requestId, p_state: s.ok ? 'accepted' : s.uncertain ? 'unknown' : 'failed',
            p_message_id: s.messageId ?? null
          });
        } catch {
          return json({ ok: false, sent: false, uncertain: true, reason: 'SMS status could not be saved. Check GHL before trying again.' }, 503);
        }
      }
      if (!s.ok) return json({ ok: true, sent: false, reason: s.reason, uncertain: s.uncertain });
      const what = label ? `Texted "${label}"` : 'Texted';
      await markQueue(id, 'worked', [label ? what : '', notes].filter(Boolean).join(' — '), tracked);
      await clearCampaign(id);
      await ghlNote(cid, `📲 Agent prospecting — ${what} via GHL ✓.` + (notes ? `\nNotes: ${notes}` : ''));
      return json({ ok: true, sent: true, saved: true });
    }

    if (!(await markQueue(id, action, notes, tracked))) return json({ ok: false, error: 'update failed' }, 500);
    if (CLEARS.includes(action) || action === 'finish') await clearCampaign(id);

    let ghl = 'skip';
    if (row && (action !== 'untext') && (action === 'worked' || notes)) {
      const base = LABELS[action] ?? action;
      const lbl = action === 'worked' && label ? `Texted "${label}" ✓` : base;
      const body = `☎️ Agent prospecting — ${lbl}.` + (notes ? `\nNotes: ${notes}` : '');
      ghl = await ghlLog(row.phone10 || row.phone_display || '', row.contact_name || '', body);
    }
    return json({ ok: true, saved: true, note_saved: !!notes, ghl });
  }

  // GET data
  if ((url.searchParams.get('k') ?? '') !== TOKEN || !TOKEN) return json({ error: 'unauthorized' }, 401);
  const n = Math.min(parseInt(url.searchParams.get('n') || '20', 10) || 20, 50);
  const nr = Math.min(parseInt(url.searchParams.get('r') || '10', 10) || 0, n);
  let list: Record<string, unknown>[] = [];
  for (const [fn, args] of [['agent_call_next2', { p_limit: n, p_recall: nr }], ['agent_call_next', { p_limit: n }]] as const) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) { list = d; break; } }
    } catch { /* */ }
  }
  if (!Array.isArray(list) || list.length === 0) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/agent_call_queue?status=eq.active&campaign=is.null&order=last_called.asc.nullsfirst,calls.asc,id.asc&limit=${n}&select=id,contact_name,first_name,brokerage,phone10,phone_display,calls,texted,notes`, { headers: H });
      if (r.ok) list = await r.json();
    } catch { /* */ }
  }

  // Campaign rows ride at the BACK, in full, outside the n limit.
  let campaignRows: Record<string, unknown>[] = [];
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/agent_call_campaign`, { method: 'POST', headers: H, body: JSON.stringify({ p_campaign: url.searchParams.get('c') || null }) });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d)) campaignRows = d; }
  } catch { /* */ }
  const seen = new Set(list.map((x) => x.id));
  list = list.concat(campaignRows.filter((x) => !seen.has(x.id)));

  const active_remaining = await countOf('status=eq.active&campaign=is.null&select=id');
  const worked_total = await countOf('status=eq.worked&select=id');
  let recall_remaining = 0;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/agent_call_next2`, { method: 'POST', headers: H, body: JSON.stringify({ p_limit: 500, p_recall: 500 }) });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d)) recall_remaining = d.filter((x: { is_recall?: boolean }) => x.is_recall).length; }
  } catch { /* */ }
  return json({ list, active_remaining, worked_total, recall_remaining, campaign_remaining: campaignRows.length });
});
