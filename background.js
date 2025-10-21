chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get('learntube_settings');
  const existingSettings = result.learntube_settings || {};
  
  const defaultSettings = {
    enabled: true,
    autoQuiz: true,
    questionCount: 1,
    finalQuizEnabled: true,
    soundEnabled: true,
    theme: 'dark'
  };
  
  chrome.storage.local.set({
    learntube_settings: { ...defaultSettings, ...existingSettings }
  });
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
    chrome.storage.local.set({ learntube_settings: message.settings }).then(() => {
      sendResponse({ success: true });
    });
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
    chrome.tabs.sendMessage(tabId, { type: 'VIDEO_LOADED' }).catch(() => {});
  }
});

