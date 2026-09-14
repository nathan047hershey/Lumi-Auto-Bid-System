/**
 * autofill/workday_auto.js
 * Workday-only autofill. Loaded only on Workday apply URLs.
 * Stub for later — keep Greenhouse logic out of this file.
 */
(function () {
  'use strict';

  if (window.__saiWorkdayAutoLoaded) return;
  window.__saiWorkdayAutoLoaded = true;

  const LOG = '[Sai:Workday]';

  function isWorkdayPage() {
    const host = location.hostname.toLowerCase();
    return (
      host.endsWith('.myworkdayjobs.com') ||
      host.includes('workday')
    );
  }

  if (!isWorkdayPage()) return;

  console.log(LOG, 'module loaded (stub)');

  window.__saiWorkday = {
    platform: 'workday',
    isReady: () => false,
    startAutofill: async () => {
      throw new Error('Workday autofill not implemented yet');
    },
    stopAutofill: () => {
      window.__saiWorkdayStopRequested = true;
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.platform !== 'workday') return;

    if (message.type === 'workdayPing') {
      sendResponse({
        success: true,
        platform: 'workday',
        ready: false,
        stub: true
      });
      return;
    }

    if (message.type === 'workdayStartAutofill') {
      sendResponse({ success: false, error: 'Workday autofill not implemented yet' });
    }
  });
})();
