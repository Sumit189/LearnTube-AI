let settings = {
  enabled: true,
  autoQuiz: true,
  questionCount: 1,
  finalQuizEnabled: true,
  soundEnabled: true,
  theme: 'dark'
};

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response) {
      settings = { ...settings, ...response };
      if (!settings.theme) {
        settings.theme = 'dark';
      }
      updateUI();
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function saveSettings() {
  try {
    await chrome.runtime.sendMessage({ 
      type: 'UPDATE_SETTINGS', 
      settings 
    });
    
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'updateSettings' }).catch(() => {});
    });
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

function updateUI() {
  document.getElementById('enabledToggle').checked = settings.enabled;
  document.getElementById('autoQuizToggle').checked = settings.autoQuiz;
  document.getElementById('finalQuizToggle').checked = settings.finalQuizEnabled;
  document.getElementById('questionCount').value = settings.questionCount;
  document.getElementById('themeSelect').value = settings.theme || 'dark';
  applyTheme(settings.theme || 'dark');
}

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
}

async function loadProgress() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
    if (response) {
      calculateStats(response);
    }
  } catch (error) {
    console.error('Error loading progress:', error);
  }
}

function calculateStats(progress) {
  let totalVideos = 0;
  let totalQuizzes = 0;
  let totalScore = 0;
  let totalQuestions = 0;
  
  for (const videoId in progress) {
    totalVideos++;
    const video = progress[videoId];
    
    if (video.segments && video.segments.length > 0) {
      video.segments.forEach(segment => {
        if (segment && segment.total > 0) {
          totalQuizzes++;
          totalScore += segment.score;
          totalQuestions += segment.total;
        }
      });
    }
    
    if (video.final && video.final.total > 0) {
      totalQuizzes++;
      totalScore += video.final.score;
      totalQuestions += video.final.total;
    }
  }
  
  const avgScore = totalQuestions > 0 
    ? Math.round((totalScore / totalQuestions) * 100) 
    : 0;
  
  document.getElementById('totalVideos').textContent = totalVideos;
  document.getElementById('totalQuizzes').textContent = totalQuizzes;
  document.getElementById('avgScore').textContent = `${avgScore}%`;
  
  if (avgScore > 0) {
    const scoreElement = document.getElementById('avgScore');
    scoreElement.style.color = avgScore >= 70 ? '#10b981' : avgScore >= 50 ? '#f59e0b' : '#ef4444';
  }
}

document.getElementById('enabledToggle').addEventListener('change', (e) => {
  settings.enabled = e.target.checked;
  saveSettings();
});

document.getElementById('autoQuizToggle').addEventListener('change', (e) => {
  settings.autoQuiz = e.target.checked;
  saveSettings();
});

document.getElementById('finalQuizToggle').addEventListener('change', (e) => {
  settings.finalQuizEnabled = e.target.checked;
  saveSettings();
});

document.getElementById('questionCount').addEventListener('change', (e) => {
  settings.questionCount = parseInt(e.target.value);
  saveSettings();
});

document.getElementById('themeSelect').addEventListener('change', (e) => {
  settings.theme = e.target.value;
  applyTheme(settings.theme);
  saveSettings();
});

document.getElementById('clearProgress').addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear all progress? This cannot be undone.')) {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_PROGRESS' });
      document.getElementById('totalVideos').textContent = '0';
      document.getElementById('totalQuizzes').textContent = '0';
      document.getElementById('avgScore').textContent = '0%';
      
      const btn = document.getElementById('clearProgress');
      const originalText = btn.innerHTML;
      btn.innerHTML = '✓ Cleared';
      btn.disabled = true;
      
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }, 2000);
    } catch (error) {
      console.error('Error clearing progress:', error);
    }
  }
});

document.getElementById('viewDocs').addEventListener('click', () => {
  chrome.tabs.create({ 
    url: 'https://developer.chrome.com/docs/ai/built-in-apis' 
  });
});

document.getElementById('clearCache').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      alert('Please navigate to a YouTube video first to clear cache!');
      return;
    }
    
    await chrome.tabs.sendMessage(tab.id, { 
      action: 'clearCache' 
    });
    
    const btn = document.getElementById('clearCache');
    btn.innerHTML = '✓ Cache Cleared — Reloading...';
    btn.disabled = true;

    // Listen for the tab to finish reloading to update button text
    const targetTabId = tab.id;
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
        btn.innerHTML = "Clear This Video's Cache";
        btn.disabled = false;
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Reload the current YouTube tab to regenerate quizzes
    await chrome.tabs.reload(targetTabId);
    
  } catch (error) {
    console.error('Error clearing cache:', error);
    alert('Error: Could not clear cache. Make sure you are on a YouTube video page.');
  }
});

document.getElementById('clearAllCache').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear ALL cached quizzes and transcripts? This will remove data for all videos.')) {
    return;
  }
  
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL_CACHE' });
    
    const btn = document.getElementById('clearAllCache');
    const originalText = btn.innerHTML;
    btn.innerHTML = '✓ All Cache Cleared';
    btn.disabled = true;
    
    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }, 2000);
    
  } catch (error) {
    console.error('Error clearing all cache:', error);
    alert('Error: Could not clear all cache.');
  }
});

async function checkModelStatus() {
  try {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      // Not on YouTube, show unavailable status
      updateModelStatus('languageModelStatus', 'not-ready', 'Not on YouTube', false);
      updateModelStatus('summarizerStatus', 'not-ready', 'Not on YouTube', false);
      return;
    }
    
    // Send message to content script to check model status
    let response = null;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { 
        action: 'checkModelStatus' 
      });
    } catch (err) {
      console.warn('LearnTube: Content script not available for model status:', err?.message || err);
      updateModelStatus('languageModelStatus', 'not-ready', 'Extension not loaded', false);
      updateModelStatus('summarizerStatus', 'not-ready', 'Extension not loaded', false);
      return;
    }
    
    if (response) {
      updateModelStatus('languageModelStatus', response.languageModel.status, response.languageModel.message, response.languageModel.canDownload);
      updateModelStatus('summarizerStatus', response.summarizer.status, response.summarizer.message, response.summarizer.canDownload);
    } else {
      updateModelStatus('languageModelStatus', 'not-ready', 'Extension not loaded', false);
      updateModelStatus('summarizerStatus', 'not-ready', 'Extension not loaded', false);
    }
    
  } catch (error) {
    console.error('Error checking model status:', error);
    updateModelStatus('languageModelStatus', 'not-ready', 'Error checking', false);
    updateModelStatus('summarizerStatus', 'not-ready', 'Error checking', false);
  }
}

function updateModelStatus(elementId, status, message, canDownload = false) {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  const dot = element.querySelector('.status-dot');
  const text = element.querySelector('.status-text');
  const downloadBtn = element.querySelector('.download-btn');
  const progressBar = element.querySelector('.progress-bar');
  
  // Remove all status classes
  dot.className = 'status-dot';
  text.className = 'status-text';
  
  // Add appropriate classes
  dot.classList.add(status);
  text.classList.add(status);
  text.textContent = message;
  
  // Show/hide download button and progress bar
  if (downloadBtn) {
    if (canDownload && status === 'not-ready') {
      downloadBtn.style.display = 'inline-block';
    } else {
      downloadBtn.style.display = 'none';
    }
  }
  
  if (progressBar) {
    if (status === 'checking' && message === 'Downloading...') {
      progressBar.style.display = 'flex';
    } else {
      progressBar.style.display = 'none';
    }
  }
}

// Download button event listeners
document.getElementById('downloadLanguageModel').addEventListener('click', async () => {
  await downloadModel('languageModel');
});

document.getElementById('downloadSummarizer').addEventListener('click', async () => {
  await downloadModel('summarizer');
});

async function downloadModel(modelType) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      alert('Please navigate to a YouTube video first to download models!');
      return;
    }
    
    // Update button text to show it's downloading
    const downloadBtn = document.getElementById(`download${modelType.charAt(0).toUpperCase() + modelType.slice(1)}`);
    if (downloadBtn) {
      downloadBtn.textContent = 'Downloading...';
      downloadBtn.disabled = true;
    }
    
    // Show a helpful message and progress bar
    const statusElement = modelType === 'languageModel' ? 'languageModelStatus' : 'summarizerStatus';
    updateModelStatus(statusElement, 'checking', 'Downloading model...', false);
    
    // Show progress bar
    const progressBar = document.getElementById(`${modelType}Progress`);
    if (progressBar) {
      progressBar.style.display = 'flex';
      const progressFill = progressBar.querySelector('.progress-fill');
      const progressText = progressBar.querySelector('.progress-text');
      progressFill.style.width = '0%';
      progressText.textContent = '0%';
    }
    
    // Send message to content script to trigger model download
    await chrome.tabs.sendMessage(tab.id, { 
      action: 'downloadModel',
      modelType: modelType
    });
    
    // Check status periodically to see if download is complete
    let checkCount = 0;
    const maxChecks = 60; // Check for up to 2 minutes
    
    const checkInterval = setInterval(async () => {
      checkCount++;
      
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { 
          action: 'checkModelStatus' 
        });
        
        if (response) {
          const modelStatus = modelType === 'languageModel' ? response.languageModel : response.summarizer;
          
          if (modelStatus.status === 'ready') {
            // Download complete
            if (progressBar) {
              const progressFill = progressBar.querySelector('.progress-fill');
              const progressText = progressBar.querySelector('.progress-text');
              progressFill.style.width = '100%';
              progressText.textContent = '100%';
              
              setTimeout(() => {
                progressBar.style.display = 'none';
              }, 1500);
            }
            
            updateModelStatus(statusElement, 'ready', 'Ready', false);
            clearInterval(checkInterval);
            
            if (downloadBtn) {
              downloadBtn.style.display = 'none';
            }
          } else if (modelStatus.status === 'checking' || modelStatus.status === 'loading') {
            updateModelStatus(statusElement, 'checking', 'Downloading model...', false);
          } else if (modelStatus.status === 'not-ready' && checkCount > 5) {
            // Only show error after a few checks to allow initialization
            updateModelStatus(statusElement, 'not-ready', 'Download failed', true);
            
            if (progressBar) {
              progressBar.style.display = 'none';
            }
            
            if (downloadBtn) {
              downloadBtn.textContent = 'Try Again';
              downloadBtn.disabled = false;
            }
            clearInterval(checkInterval);
          }
        }
      } catch (error) {
        console.error('LearnTube: Error checking model status:', error);
      }
      
      if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        
        if (progressBar) {
          progressBar.style.display = 'none';
        }
        
        if (downloadBtn) {
          downloadBtn.textContent = 'Try Again';
          downloadBtn.disabled = false;
        }
      }
    }, 2000); // Check every 2 seconds
    
  } catch (error) {
    console.error('Error downloading model:', error);
    alert('Error: Could not download model. Make sure you are on a YouTube video page.');
  }
}

// Share progress functionality
async function shareProgress() {
  try {
    const activeSeg = document.querySelector('#shareScope .seg-btn.active');
    const scope = activeSeg ? activeSeg.getAttribute('data-scope') : 'video';
    let shareText = '';

    if (scope === 'video') {
      // Get current video info from content script
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.url || !tab.url.includes('youtube.com/watch')) {
        alert('Please open a YouTube video to share progress');
        return;
      }

      // Get video title and progress from content script
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoProgress' });
      
      if (!response || !response.success) {
        alert('No progress data found for this video');
        return;
      }

      const { videoTitle, totalQuestions, totalCorrect, accuracy } = response.data;
      
      // Create share text for current video
      shareText = `🎓 Quiz Progress: "${videoTitle}"

📊 Results:
• Questions: ${totalQuestions}
• Correct: ${totalCorrect}
• Accuracy: ${accuracy}%

🧠 Enhanced with LearnTube AI
Transform YouTube into interactive learning with AI-powered quizzes.

Get LearnTube AI: https://github.com/sumit189/learntube-ai`;
    } else {
      // Overall progress
      const progress = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
      if (!progress) {
        alert('No overall progress found');
        return;
      }

      let totalVideos = 0;
      let totalQuizzes = 0;
      let totalScore = 0;
      let totalQuestions = 0;
      
      for (const videoId in progress) {
        totalVideos++;
        const video = progress[videoId];
        
        if (video.segments && video.segments.length > 0) {
          video.segments.forEach(segment => {
            if (segment && segment.total > 0) {
              totalQuizzes++;
              totalScore += (segment.score || 0);
              totalQuestions += segment.total;
            }
          });
        }
        
        if (video.final && video.final.total > 0) {
          totalQuizzes++;
          totalScore += (video.final.score || 0);
          totalQuestions += video.final.total;
        }
      }
      
      const accuracy = totalQuestions > 0 ? Math.round((totalScore / totalQuestions) * 100) : 0;
      
      shareText = `🎓 Overall Quiz Progress

📊 Results:
• Videos: ${totalVideos}
• Quizzes: ${totalQuizzes}
• Questions: ${totalQuestions}
• Correct: ${totalScore}
• Accuracy: ${accuracy}%

🧠 Enhanced with LearnTube AI
Transform YouTube into interactive learning with AI-powered quizzes.

Get LearnTube AI: https://github.com/sumit189/learntube-ai`;
    }

    // Copy to clipboard
    await navigator.clipboard.writeText(shareText);
    
    // Show success message
    const shareBtn = document.getElementById('shareProgress');
    const originalText = shareBtn.textContent;
    shareBtn.textContent = 'Copied!';
    shareBtn.style.background = 'rgba(0, 102, 204, 0.1)';
    shareBtn.style.borderColor = '#0066cc';
    
    setTimeout(() => {
      shareBtn.textContent = originalText;
      shareBtn.style.background = '';
      shareBtn.style.borderColor = '';
    }, 2000);
    
  } catch (error) {
    console.error('Error sharing progress:', error);
    alert('Failed to share progress. Please try again.');
  }
}

// Add event listener for share button
document.getElementById('shareProgress').addEventListener('click', shareProgress);

// Segmented control behavior
document.querySelectorAll('#shareScope .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#shareScope .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

loadSettings();
loadProgress();
checkModelStatus();

// Listen for storage changes and update progress in real-time
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.learntube_progress) {
    calculateStats(changes.learntube_progress.newValue || {});
  }
});

// Listen for model download progress messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MODEL_DOWNLOAD_PROGRESS') {
    const { modelType, progress } = message;
    
    // Update progress bar
    const progressBar = document.getElementById(`${modelType}Progress`);
    if (progressBar && progressBar.style.display !== 'none') {
      const progressFill = progressBar.querySelector('.progress-fill');
      const progressText = progressBar.querySelector('.progress-text');
      
      if (progressFill && progressText) {
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;
        
        // If download complete, check status to update UI
        if (progress >= 100) {
          setTimeout(() => {
            checkModelStatus();
          }, 1000);
        }
      }
    }
    
    // Update status text
    const statusElement = modelType === 'languageModel' ? 'languageModelStatus' : 'summarizerStatus';
    if (progress < 100) {
      updateModelStatus(statusElement, 'checking', `Downloading ${progress}%...`, false);
    }
  }
  
  return true;
});

