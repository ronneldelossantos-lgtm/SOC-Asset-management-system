'use strict';

/* Runs on a schedule (see .github/workflows/seatalk-notify.yml). Reads the
   app's own Firestore sections, diffs them against what this bot last saw
   (a small state doc it maintains itself), and posts to the one SeaTalk
   group chat it's been added to for:
     1. any request or return whose status changed since the last run
     2. a new request that needs department-approval (status 'Dept Approval')
     3. a SKU that has just crossed below its safety-stock threshold

   All three notifications go to the same group — no per-user routing, no
   actual approval workflow here, just "something happened" notices (per
   explicit direction: approval routing was decided as unnecessary
   complexity for this).

   On the very first run (no state doc yet), everything gets *seeded*
   without sending anything — otherwise every request/return/SKU that
   already existed would look "new" and flood the group on day one. */

const { getAccessToken, getJoinedGroupIds, sendGroupTextMessage } = require('./seatalk-client');
const { readSection, readDoc } = require('./firestore-sections');
const { writeStatus } = require('./firestore-status');

const STATE_KEY = 'notifbot__state';

// ---- Replicates index.html's safety-stock math exactly (see
// dailyAvgConsumption / safetyStockOf / stockOf in index.html) ----

function dailyAvgConsumption(sku, issuance) {
  const records = issuance.filter(i => i.sku === sku);
  if (records.length === 0) return 0;
  const totalQty = records.reduce((s, r) => s + Number(r.qty || 0), 0);
  const earliest = Math.min(...records.map(r => new Date(r.date).getTime()));
  const days = Math.max(1, Math.ceil((Date.now() - earliest) / (1000 * 60 * 60 * 24)));
  return totalQty / days;
}

function safetyStockOf(s, issuance) {
  const dac = dailyAvgConsumption(s.sku, issuance);
  const days = [7, 15, 30].includes(s.safetyStockDays) ? s.safetyStockDays : 7;
  return Math.ceil(dac * days);
}

function stockOfAllSocs(sku, stock) {
  let total = 0;
  Object.keys(stock || {}).forEach(soc => {
    total += Number(((stock[soc] || {})[sku]) || 0);
  });
  return total;
}

function computeBelowSafetyStock(sku, stock, issuance) {
  const soh = stockOfAllSocs(sku.sku, stock);
  const safety = safetyStockOf(sku, issuance);
  return { soh, safety, below: soh <= safety };
}

// ---- Message formatting ----
// One combined message per run (grouped by section, one line per event)
// instead of one SeaTalk API call per individual event — a run with, say,
// 4 safety-stock drops and 3 status changes used to cost 7 send calls and
// 7 separate chat notifications; it now costs 1 call and 1 notification.

// A request carries an `items` array (each with sku/description/qty); a
// return is a single item flattened onto the record itself (sku/description/
// qty directly on r). Both get summarized the same way so the digest reads
// "what was it" rather than just a ticket number.
function itemsSummary(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const shown = items.slice(0, 3).map(it => `${it.description || it.sku} x${it.qty}`);
  const extra = items.length > 3 ? `, +${items.length - 3} more` : '';
  return shown.join(', ') + extra;
}

function statusLine(r, oldStatus, itemsText) {
  const base = `${r.id}: ${oldStatus ? oldStatus : '(new)'} → ${r.status}`;
  return itemsText ? `${base} — ${itemsText}` : base;
}

function formatSection(title, count, lines) {
  if (!count) return null;
  return `${title} (${count})\n${lines.join('\n')}`;
}

function buildDigestMessage({ belowSafetyStock, requestChanges, approvalsNeeded, returnChanges }) {
  const sections = [
    formatSection('🔻 Below safety stock', belowSafetyStock.length,
      belowSafetyStock.map(({ sku, soh, safety }) => `${sku.sku} — ${sku.description}: ${soh}/${safety}`)),
    formatSection('📦 Request updates', requestChanges.length,
      requestChanges.map(({ r, oldStatus }) => statusLine(r, oldStatus, itemsSummary(r.items)))),
    formatSection('⚠️ Needs approval', approvalsNeeded.length,
      approvalsNeeded.map(r => {
        const items = itemsSummary(r.items);
        return `${r.id} — Requested by ${r.requestedBy} (${r.department})${items ? ': ' + items : ''}`;
      })),
    formatSection('↩️ Returns', returnChanges.length,
      returnChanges.map(({ r, oldStatus }) => statusLine(r, oldStatus, itemsSummary([{ description: r.description, sku: r.sku, qty: r.qty }])))),
  ].filter(Boolean);
  return sections.length ? sections.join('\n\n') : null;
}

async function main() {
  const appId = process.env.SEATALK_APP_ID;
  const appSecret = process.env.SEATALK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('SEATALK_APP_ID / SEATALK_APP_SECRET not set');

  const [requests, returns, skuList, stock, issuance, state] = await Promise.all([
    readSection('requests'),
    readSection('returns'),
    readSection('sku'),
    readSection('stock'),
    readSection('issuance'),
    readDoc(STATE_KEY),
  ]);

  const firstRun = !state;
  const prevRequestStatuses = (state && state.requestStatuses) || {};
  const prevReturnStatuses = (state && state.returnStatuses) || {};
  const prevNotifiedApprovals = new Set((state && state.notifiedApprovals) || []);
  const prevBelowSafetyStock = new Set((state && state.belowSafetyStock) || []);

  const requestChanges = [];
  const approvalsNeeded = [];
  const nextRequestStatuses = {};
  const nextNotifiedApprovals = new Set(prevNotifiedApprovals);

  (requests || []).forEach(r => {
    nextRequestStatuses[r.id] = r.status;
    if (!firstRun) {
      const old = prevRequestStatuses[r.id];
      if (old !== r.status) requestChanges.push({ r, oldStatus: old });
      if (r.status === 'Dept Approval' && !prevNotifiedApprovals.has(r.id)) {
        approvalsNeeded.push(r);
      }
    }
    if (r.status === 'Dept Approval') nextNotifiedApprovals.add(r.id);
  });

  const returnChanges = [];
  const nextReturnStatuses = {};
  (returns || []).forEach(r => {
    nextReturnStatuses[r.id] = r.status;
    if (!firstRun) {
      const old = prevReturnStatuses[r.id];
      if (old !== r.status) returnChanges.push({ r, oldStatus: old });
    }
  });

  const belowSafetyStock = [];
  const nextBelowSafetyStock = new Set();
  (skuList || []).forEach(s => {
    const { soh, safety, below } = computeBelowSafetyStock(s, stock || {}, issuance || []);
    if (below) {
      nextBelowSafetyStock.add(s.sku);
      if (!firstRun && !prevBelowSafetyStock.has(s.sku)) {
        belowSafetyStock.push({ sku: s, soh, safety });
      }
    }
  });

  const digest = firstRun ? null : buildDigestMessage({ belowSafetyStock, requestChanges, approvalsNeeded, returnChanges });
  const eventCount = belowSafetyStock.length + requestChanges.length + approvalsNeeded.length + returnChanges.length;
  console.log(firstRun ? 'First run — seeding state without sending notifications.' : `${eventCount} event(s) found.`);
  if (digest) console.log('---\n' + digest);

  let sent = 0;
  if (digest) {
    const token = await getAccessToken(appId, appSecret);
    const groupIds = await getJoinedGroupIds(token);
    if (groupIds.length !== 1) {
      throw new Error(`Expected the bot to be in exactly 1 group, found ${groupIds.length}: ${JSON.stringify(groupIds)}`);
    }
    await sendGroupTextMessage(token, groupIds[0], digest);
    sent = 1;
  }

  await writeStatus(STATE_KEY, {
    requestStatuses: nextRequestStatuses,
    returnStatuses: nextReturnStatuses,
    notifiedApprovals: [...nextNotifiedApprovals],
    belowSafetyStock: [...nextBelowSafetyStock],
  });

  await writeStatus('notifbot__last_run', {
    ok: true,
    firstRun,
    eventsFound: eventCount,
    messagesSent: sent,
    checkedAt: Date.now(),
  });
}

main().catch(async err => {
  console.error('FAILED:', err.message);
  await writeStatus('notifbot__last_run', { ok: false, error: err.message, checkedAt: Date.now() });
  process.exit(1);
});
