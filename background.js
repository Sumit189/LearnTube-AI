const ANALYTICS_CONFIG = {
  ENDPOINT: 'https://learntubeai-analytics.sumit-18-paul.workers.dev',
  CLIENT_ID_KEY: 'learntube_analytics_client_id'
};

let analyticsSequence = 0;

async function getStoredSettings() {
  const result = await chrome.storage.local.get('learntube_settings');
  return result.learntube_settings || {};
}

async function isAnalyticsEnabled() {
  try {
    const settings = await getStoredSettings();
    return settings.analyticsEnabled !== false;
  } catch (error) {
    console.warn('LearnTube: Analytics preference unavailable:', error);
    return false;
  }
}

async function getAnalyticsClientId() {
  const stored = await chrome.storage.local.get(ANALYTICS_CONFIG.CLIENT_ID_KEY);
  let clientId = stored?.[ANALYTICS_CONFIG.CLIENT_ID_KEY];
  if (!clientId) {
    try {
      clientId = crypto.randomUUID();
    } catch {
      clientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    await chrome.storage.local.set({ [ANALYTICS_CONFIG.CLIENT_ID_KEY]: clientId });
  }
  return clientId;
}

async function sendAnalyticsEvent(eventName, params = {}, options = {}) {
  const { force = false } = options;
  if (!ANALYTICS_CONFIG.ENDPOINT || !eventName) {
    return;
  }

  let allowed = force;
  if (!allowed) {
    allowed = await isAnalyticsEnabled();
  }
  if (!allowed) {
    return;
  }

  try {
    const clientId = await getAnalyticsClientId();
    analyticsSequence += 1;

    const body = {
      client_id: clientId,
      events: [
        {
          name: eventName,
          params: {
            ...params,
            app_platform: 'chrome_extension',
            engagement_time_msec: 1,
            hit_sequence: analyticsSequence
          }
        }
      ]
    };

    await fetch(ANALYTICS_CONFIG.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    });
  } catch (error) {
    console.warn('LearnTube: Analytics event failed:', error);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const result = await chrome.storage.local.get('learntube_settings');
  const existingSettings = result.learntube_settings || {};

  const defaultSettings = {
    enabled: true,
    autoQuiz: true,
    questionCount: 1,
    finalQuizEnabled: true,
    soundEnabled: true,
    theme: 'light',
    themeScope: 'quiz-popup',
    analyticsEnabled: true
  };

  await chrome.storage.local.set({
    learntube_settings: { ...defaultSettings, ...existingSettings }
  });

  if (details.reason === 'install') {
    await sendAnalyticsEvent('user_install', { source: 'extension_install' }, { force: true });
  } else if (details.reason === 'update') {
    await sendAnalyticsEvent('user_update', { source: 'extension_update' }, { force: true });
  }
});


const CACHE_PREFIXES = {
  QUIZ: 'learntube_quiz_',
  TRANSCRIPT: 'learntube_transcript_',
  LRU: 'learntube_cache_lru',
  STATUS: 'learntube_generation_status'
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'test') {
    sendResponse({ status: 'Background script is working!' });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.local.get('learntube_settings').then(data => {
      sendResponse(data.learntube_settings || {});
    });
    return true;
  }

  if (message.type === 'UPDATE_SETTINGS') {
    (async () => {
      try {
        const previousSettings = await getStoredSettings();
        await chrome.storage.local.set({ learntube_settings: message.settings });
        sendResponse({ success: true });

        const prevEnabled = previousSettings.analyticsEnabled !== false;
        const nextEnabled = message.settings.analyticsEnabled !== false;
        if (prevEnabled !== nextEnabled) {
          const eventName = nextEnabled ? 'analytics_opt_in' : 'analytics_opt_out';
          await sendAnalyticsEvent(eventName, { source: 'popup_toggle' }, { force: true });
        }
      } catch (error) {
        console.error('LearnTube: Error updating settings:', error);
        sendResponse({ success: false, error: error?.message });
      }
    })();
    return true;
  }

  if (message.type === 'TRACK_ANALYTICS') {
    (async () => {
      try {
        await sendAnalyticsEvent(message.event, message.params || {});
        sendResponse({ success: true });
      } catch (error) {
        console.warn('LearnTube: Failed to enqueue analytics event:', error);
        sendResponse({ success: false, error: error?.message });
      }
    })();
    return true;
  }

  if (message.type === 'GET_PROGRESS') {
    chrome.storage.local.get('learntube_progress').then(data => {
      sendResponse(data.learntube_progress || {});
    });
    return true;
  }

  if (message.type === 'CLEAR_PROGRESS') {
    chrome.storage.local.remove('learntube_progress').then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'GET_GENERATION_STATUS') {
    chrome.storage.local.get(CACHE_PREFIXES.STATUS).then(data => {
      sendResponse(data[CACHE_PREFIXES.STATUS] || {});
    }).catch(error => {
      console.error('LearnTube: Error retrieving generation status:', error);
      sendResponse({});
    });
    return true;
  }

  if (message.type === 'CLEAR_ALL_CACHE') {
    chrome.storage.local.get(null).then(items => {
      const keysToRemove = Object.keys(items).filter(key =>
        key.startsWith(CACHE_PREFIXES.QUIZ) ||
        key.startsWith(CACHE_PREFIXES.TRANSCRIPT) ||
        key === CACHE_PREFIXES.LRU ||
        key === CACHE_PREFIXES.STATUS
      );

      if (keysToRemove.length === 0) {
        sendResponse({ success: true });
        return;
      }

      chrome.storage.local.remove(keysToRemove).then(() => {
        sendResponse({ success: true, removed: keysToRemove.length });
      }).catch(error => {
        console.error('LearnTube: Error clearing all cache:', error);
        sendResponse({ success: false, error: error.message });
      });
    }).catch(error => {
      console.error('LearnTube: Error reading cache before clear:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com/watch')) {
    chrome.tabs.sendMessage(tabId, { type: 'VIDEO_LOADED' }).catch(() => { });
  }
});

