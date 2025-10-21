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
  
  if (message.type === 'CLEAR_ALL_CACHE') {
    chrome.tabs.query({ url: '*://*.youtube.com/*' }).then(tabs => {
      const promises = tabs.map(tab => {
        return chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key.startsWith('learntube_quiz_') || key.startsWith('learntube_transcript_')) {
                keysToRemove.push(key);
              }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
            console.log(`LearnTube: Cleared ${keysToRemove.length} cache items`);
          }
        }).catch(() => {});
      });
      
      Promise.all(promises).then(() => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com/watch')) {
    chrome.tabs.sendMessage(tabId, { type: 'VIDEO_LOADED' }).catch(() => {});
  }
});

