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

function requestStatusMessage(r, oldStatus) {
  const transition = oldStatus ? `${oldStatus} → ${r.status}` : `(new) → ${r.status}`;
  return `📦 ${r.id} status updated: ${transition}\nRequested by: ${r.requestedBy} (${r.department})`;
}

function returnStatusMessage(r, oldStatus) {
  const transition = oldStatus ? `${oldStatus} → ${r.status}` : `(new) → ${r.status}`;
  return `↩️ ${r.id} status updated: ${transition}\n${r.sku} — ${r.description} (${r.department})`;
}

function approvalNeededMessage(r) {
  return `⚠️ New request ${r.id} needs approval\nRequested by: ${r.requestedBy} (${r.department})\nApprover: ${r.requiresApprovalFrom}`;
}

function belowSafetyStockMessage(sku, soh, safety) {
  return `🔻 ${sku.sku} — ${sku.description} is below safety stock\nOn hand: ${soh} | Safety stock: ${safety}`;
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

  const messages = [];
  const nextRequestStatuses = {};
  const nextNotifiedApprovals = new Set(prevNotifiedApprovals);

  (requests || []).forEach(r => {
    nextRequestStatuses[r.id] = r.status;
    if (!firstRun) {
      const old = prevRequestStatuses[r.id];
      if (old !== r.status) messages.push(requestStatusMessage(r, old));
      if (r.status === 'Dept Approval' && !prevNotifiedApprovals.has(r.id)) {
        messages.push(approvalNeededMessage(r));
      }
    }
    if (r.status === 'Dept Approval') nextNotifiedApprovals.add(r.id);
  });

  const nextReturnStatuses = {};
  (returns || []).forEach(r => {
    nextReturnStatuses[r.id] = r.status;
    if (!firstRun) {
      const old = prevReturnStatuses[r.id];
      if (old !== r.status) messages.push(returnStatusMessage(r, old));
    }
  });

  const nextBelowSafetyStock = new Set();
  (skuList || []).forEach(s => {
    const { soh, safety, below } = computeBelowSafetyStock(s, stock || {}, issuance || []);
    if (below) {
      nextBelowSafetyStock.add(s.sku);
      if (!firstRun && !prevBelowSafetyStock.has(s.sku)) {
        messages.push(belowSafetyStockMessage(s, soh, safety));
      }
    }
  });

  console.log(firstRun ? 'First run — seeding state without sending notifications.' : `${messages.length} notification(s) to send.`);
  messages.forEach(m => console.log('---\n' + m));

  let sent = 0;
  if (!firstRun && messages.length) {
    const token = await getAccessToken(appId, appSecret);
    const groupIds = await getJoinedGroupIds(token);
    if (groupIds.length !== 1) {
      throw new Error(`Expected the bot to be in exactly 1 group, found ${groupIds.length}: ${JSON.stringify(groupIds)}`);
    }
    for (const message of messages) {
      await sendGroupTextMessage(token, groupIds[0], message);
      sent++;
    }
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
    messagesFound: messages.length,
    messagesSent: sent,
    checkedAt: Date.now(),
  });
}

main().catch(async err => {
  console.error('FAILED:', err.message);
  await writeStatus('notifbot__last_run', { ok: false, error: err.message, checkedAt: Date.now() });
  process.exit(1);
});
