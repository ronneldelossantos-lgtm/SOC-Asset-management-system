'use strict';

/* Minimal SeaTalk Open Platform bot client — just the calls this project
   needs (auth, list joined groups, send a group text message). API shape
   confirmed against https://github.com/anandawira/seatalkbot (a working
   third-party client), since SeaTalk's own docs require a logged-in
   session and can't be fetched by an automated script. */

const HOST = 'https://openapi.seatalk.io';

async function getAccessToken(appId, appSecret) {
  const res = await fetch(`${HOST}/auth/app_access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 0 || !body.app_access_token) {
    throw new Error(`auth failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.app_access_token;
}

/* Returns the raw, unparsed response body of the first page — used for
   diagnostics when the parsed group list comes back empty despite the bot
   visibly being a group member, since the exact response shape here is
   taken from an unofficial third-party client (SeaTalk's own docs require
   a logged-in session), not SeaTalk's own reference. */
async function getJoinedGroupsRaw(accessToken) {
  const url = new URL(`${HOST}/messaging/v2/group_chat/joined`);
  url.searchParams.set('page_size', '50');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { unparsableText: text }; }
  return { status: res.status, body };
}

async function getJoinedGroupIds(accessToken) {
  const groupIds = [];
  let cursor = '';
  for (;;) {
    const url = new URL(`${HOST}/messaging/v2/group_chat/joined`);
    url.searchParams.set('page_size', '50');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json();
    if (!res.ok || body.code !== 0) {
      throw new Error(`get joined groups failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    }
    groupIds.push(...((body.joined_group_chats && body.joined_group_chats.group_ids) || []));
    cursor = body.next_cursor || '';
    if (!cursor) break;
  }
  return groupIds;
}

async function sendGroupTextMessage(accessToken, groupId, content) {
  const res = await fetch(`${HOST}/messaging/v2/group_chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      group_id: groupId,
      message: { tag: 'text', text: { content } },
    }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 0) {
    throw new Error(`send group message failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.message_id;
}

module.exports = { getAccessToken, getJoinedGroupIds, getJoinedGroupsRaw, sendGroupTextMessage };
