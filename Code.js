/**
 * Calendar Webhook — Apps Script entry point.
 * Receives Google Calendar API push notifications and updates lessons_today.
 * Config (WEBHOOK_URL, SS_ID, etc.) in Config.js — files are merged into one scope.
 *
 * Flow:
 * 1. Deploy as Web App (Anyone) → copy the URL below
 * 2. Run registerCalendarWatch() once to register the watch
 * 3. When events change, Google POSTs to the webhook
 * 4. doPost() fetches events and updates sheets (MonthlySchedule via MonthlyCache.js, lessons_today via Functions.js)
 */

/**
 * Debug: log when a POST request is received. Writes to WebhookLog sheet (Logger.log doesn't work with doPost).
 * @param {GoogleAppsScript.Events.DoPost} e - The doPost event object
 * @param {string=} extra - Optional extra info (e.g. error message)
 */
function logWebhookReceived(e, extra) {
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    let sheet = ss.getSheetByName(WEBHOOK_LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(WEBHOOK_LOG_SHEET);
      sheet.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Event', 'HasParams', 'Details']]);
    }
    const now = new Date();
    const hasParams = e && (e.parameters || (e.postData && e.postData.contents));
    const details = extra || (e && e.postData ? String(e.postData.contents).slice(0, 200) : '') || '';
    sheet.appendRow([now, 'POST received', !!hasParams, details]);
  } catch (err) {
    // Fallback: try to write to AppState or first sheet if WebhookLog fails
    try {
      const ss = SpreadsheetApp.openById(SS_ID);
      const sheet = ss.getSheets()[0];
      sheet.appendRow([new Date(), 'WebhookLog error:', String(err)]);
    } catch (_) {}
  }
}

/** GET handler — no UI needed; webhook uses POST only */
function doGet() {
  return ContentService.createTextOutput('Calendar Webhook — use POST')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Webhook handler — receives Calendar API push notifications.
 * Apps Script does not expose request headers, so we run sync on every POST.
 * Google POSTs when events change; we refresh lessons_today and return 200.
 */
function doPost(e) {
  logWebhookReceived(e);

  try {
    cacheMonthlyEventsForBothMonths();
    fetchAndCacheTodayLessons();
  } catch (err) {
    logWebhookReceived(e, 'Sync error: ' + String(err));
  }

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Register Calendar API push notifications for all lesson calendars.
 * Run ONCE after deploying the Web App. Re-run every ~6 days (channels expire).
 * Uses WEBHOOK_URL from the top of this file (paste your deployment URL there).
 *
 * @param {string=} webhookUrl - Optional override; defaults to WEBHOOK_URL
 */
function registerCalendarWatch(webhookUrl) {
  const url = webhookUrl || WEBHOOK_URL;
  if (!url || !url.startsWith('https://') || url.includes('YOUR_DEPLOYMENT_ID')) {
    throw new Error('Set WEBHOOK_URL at the top of Code.js to your deployed Web App URL');
  }

  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000; // ~6 days

  const calendars = [
    { id: 'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com', name: 'main' },
    { id: 'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com', name: 'demo' },
    { id: 'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com', name: 'owner' },
  ];

  for (const cal of calendars) {
    try {
      const channel = {
        id: Utilities.getUuid(),
        type: 'web_hook',
        address: url,
        expiration: expiration,
      };
      const result = Calendar.Events.watch(channel, cal.id);
      Logger.log('Registered watch for %s: %s', cal.name, JSON.stringify(result));
    } catch (err) {
      Logger.log('Failed to register watch for %s: %s', cal.name, err);
    }
  }

  Logger.log('Calendar watch registration complete. Re-run in ~6 days.');
}

/**
 * Manual test: run from Editor to sync lessons_today without waiting for webhook.
 * Use this to verify the sync logic works. If this succeeds, the issue is webhook delivery.
 */
function manualSync() {
  cacheMonthlyEventsForBothMonths();
  fetchAndCacheTodayLessons();
  Logger.log('Manual sync complete. Check lessons_today and MonthlySchedule sheets.');
}
