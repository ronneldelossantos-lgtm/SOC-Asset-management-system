'use strict';

/* One-off connectivity check, run manually via the "Test SeaTalk Connection"
   GitHub Actions workflow (workflow_dispatch). Confirms the App ID/Secret
   work and reports which group(s) the bot has been added to — nothing is
   sent unless SEND_TEST_MESSAGE=true and the bot is already in exactly one
   group, so this is safe to run repeatedly while setting things up. */

const { getAccessToken, getJoinedGroupIds, getJoinedGroupsRaw, sendGroupTextMessage } = require('./seatalk-client');
const { writeStatus } = require('./firestore-status');

async function main() {
  const appId = process.env.SEATALK_APP_ID;
  const appSecret = process.env.SEATALK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('SEATALK_APP_ID / SEATALK_APP_SECRET not set');
  }

  console.log('Requesting app_access_token...');
  const token = await getAccessToken(appId, appSecret);
  console.log('Auth OK.');

  console.log('Fetching raw joined-groups response for diagnostics...');
  const raw = await getJoinedGroupsRaw(token);
  console.log('Raw response:', JSON.stringify(raw));

  console.log('Listing groups the bot has been added to...');
  const groupIds = await getJoinedGroupIds(token);
  console.log(`Bot is in ${groupIds.length} group(s):`, groupIds);

  let testMessageSent = false;
  if (process.env.SEND_TEST_MESSAGE === 'true') {
    if (groupIds.length !== 1) {
      console.log(
        `Skipping test message — expected exactly 1 joined group, found ${groupIds.length}. ` +
          `Add the bot to exactly one group chat before sending a test message.`
      );
    } else {
      console.log('Sending test message...');
      const messageId = await sendGroupTextMessage(
        token,
        groupIds[0],
        'SOC Asset Management bot connected successfully. This is a one-time test message.'
      );
      console.log('Sent. message_id =', messageId);
      testMessageSent = true;
    }
  }

  await writeStatus('test_connection_status', {
    ok: true,
    groupCount: groupIds.length,
    groupIds,
    testMessageSent,
    rawJoinedGroupsResponse: raw,
    checkedAt: Date.now(),
  });
}

main().catch(async err => {
  console.error('FAILED:', err.message);
  await writeStatus('test_connection_status', { ok: false, error: err.message, checkedAt: Date.now() });
  process.exit(1);
});
