let settings = {
  enabled: true,
  autoQuiz: true,
  questionCount: 1,
  finalQuizEnabled: true,
  soundEnabled: true,
  theme: 'dark'
};

const STATUS_LABELS = {
  completed: 'Completed',
  ready: 'Ready',
  processing: 'Processing',
  pending: 'Pending',
  error: 'Failed',
  skipped: 'Skipped',
  idle: 'Idle'
};

const modelStates = {
  languageModel: { status: 'checking', message: 'Checking...', canDownload: false },
  summarizer: { status: 'checking', message: 'Checking...', canDownload: false }
};

let downloadInProgress = false;

const downloadModelsBtn = document.getElementById('downloadModels');
const downloadModelsHelp = document.getElementById('downloadModelsHelp');

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function classForStatus(rawStatus) {
  const status = (rawStatus || '').toString().toLowerCase();
  if (status === 'completed' || status === 'ready') return 'status-pill status-completed';
  if (status === 'processing' || status === 'in-progress') return 'status-pill status-processing';
  if (status === 'error' || status === 'failed') return 'status-pill status-error';
  if (status === 'skipped') return 'status-pill status-skipped';
  return 'status-pill status-pending';
}

function labelForStatus(rawStatus) {
  const status = (rawStatus || '').toString().toLowerCase();
  return STATUS_LABELS[status] || STATUS_LABELS.pending;
}

function deriveOverallStatus(status) {
  if (!status) return 'pending';
  const overall = (status.overallStatus || '').toString().toLowerCase();
  if (overall) return overall;
  const finalStatus = (status.final?.status || '').toString().toLowerCase();
  if (finalStatus === 'error') return 'error';
  return 'processing';
}

function updateStatusSummary(state = 'pending', labelOverride) {
  const pill = document.getElementById('statusSummaryPill');
  if (!pill) return;
  const normalized = (state || 'pending').toString().toLowerCase();
  pill.className = classForStatus(normalized);
  pill.textContent = labelOverride ? labelOverride : labelForStatus(normalized);
}

function setModelState(modelType, state) {
  if (!modelType || !modelStates[modelType]) {
    return;
  }
  modelStates[modelType] = {
    status: (state?.status || 'not-ready'),
    message: state?.message || '',
    canDownload: Boolean(state?.canDownload)
  };
}

function updateDownloadModelsBtn() {
  if (!downloadModelsBtn) {
    return;
  }

  const languageState = modelStates.languageModel || {};
  const summarizerState = modelStates.summarizer || {};
  const needsDownload = [languageState, summarizerState].some(state => state?.status === 'not-ready' && state?.canDownload);
  const hadFailure = [languageState, summarizerState].some(state => (state?.message || '').toLowerCase().includes('failed'));

  if (downloadInProgress) {
    downloadModelsBtn.style.display = 'block';
    downloadModelsBtn.disabled = true;
    const currentLabel = (downloadModelsBtn.textContent || '').toLowerCase();
    if (!currentLabel.includes('download')) {
      downloadModelsBtn.textContent = 'Downloading...';
    }
  } else if (needsDownload) {
    downloadModelsBtn.style.display = 'block';
    downloadModelsBtn.disabled = false;
    downloadModelsBtn.textContent = hadFailure ? 'Try Again' : 'Download AI Models';
  } else {
    downloadModelsBtn.style.display = 'none';
  }

  if (downloadModelsHelp) {
    downloadModelsHelp.style.display = (downloadInProgress || needsDownload) ? 'block' : 'none';
  }
}

const statusSectionEl = document.getElementById('statusSection');
const statusToggleBtn = document.getElementById('statusToggle');
const statusContentEl = document.getElementById('statusContent');
if (statusContentEl) {
  const initiallyCollapsed = statusSectionEl?.classList.contains('collapsed');
  statusContentEl.setAttribute('aria-hidden', initiallyCollapsed ? 'true' : 'false');
}
if (statusToggleBtn && statusSectionEl) {
  statusToggleBtn.addEventListener('click', () => {
    const expanded = statusToggleBtn.getAttribute('aria-expanded') === 'true';
    statusToggleBtn.setAttribute('aria-expanded', String(!expanded));
    statusSectionEl.classList.toggle('collapsed', expanded);
    if (statusContentEl) {
      statusContentEl.setAttribute('aria-hidden', expanded ? 'true' : 'false');
    }
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp && timestamp !== 0) return 'Just now';
  const tsNumber = Number(timestamp);
  if (!Number.isFinite(tsNumber)) return 'Just now';
  const diff = Date.now() - tsNumber;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) {
    const minutes = Math.round(diff / 60000);
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  }
  if (diff < 86400000) {
    const hours = Math.round(diff / 3600000);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const date = new Date(tsNumber);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : 'Earlier';
}

function renderCurrentStatus(status) {
  const videoTitle = escapeHtml(status?.videoTitle || 'Current video');
  const segments = Array.isArray(status?.segments) ? status.segments : [];
  let completed = 0;
  let processing = 0;
  let pending = 0;
  let errors = 0;
  const errorMessages = [];

  segments.forEach(segment => {
    const segStatus = (segment?.status || '').toLowerCase();
    if (segStatus === 'completed' || segStatus === 'ready') {
      completed += 1;
    } else if (segStatus === 'processing') {
      processing += 1;
    } else if (segStatus === 'error') {
      errors += 1;
      if (segment?.message) {
        const index = typeof segment.index === 'number' ? segment.index + 1 : '?';
        errorMessages.push(`Segment ${index}: ${segment.message}`);
      }
    } else {
      pending += 1;
    }
  });

  const metrics = [
    { label: 'Total segments', value: segments.length },
    { label: 'Completed', value: completed },
    { label: 'Processing', value: processing },
    { label: 'Pending', value: pending }
  ];
  if (errors > 0) {
    metrics.push({ label: 'Failed', value: errors });
  }

  const totalSegments = segments.length;
  const progressPercent = totalSegments ? Math.round((completed / totalSegments) * 100) : 0;
  const progressLabel = totalSegments
    ? `${completed}/${totalSegments} segments ready`
    : 'Waiting for first quiz';

  const metricsMarkup = totalSegments
    ? `<div class="status-metrics">${metrics.map(metric => `
        <div class="status-metric">
          <div class="status-metric-label">${escapeHtml(metric.label)}</div>
          <div class="status-metric-value">${escapeHtml(String(metric.value))}</div>
        </div>
      `).join('')}</div>`
    : '';

  const progressMarkup = totalSegments
    ? `
      <div class="status-progress">
        <div class="status-progress-label">
          <span>Segment progress</span>
          <span>${progressPercent}%</span>
        </div>
        <div class="status-progress-bar">
          <div class="status-progress-fill" style="width:${progressPercent}%"></div>
        </div>
        <div class="status-progress-helper">${escapeHtml(progressLabel)}</div>
      </div>
    `.trim()
    : `
      <div class="status-progress waiting">
        <div class="status-progress-label">
          <span>Segment progress</span>
          <span>—</span>
        </div>
        <div class="status-progress-helper">${escapeHtml(progressLabel)}</div>
      </div>
    `.trim();

  const finalStatusObj = status?.final || {};
  const finalStatus = (finalStatusObj.status || 'skipped').toLowerCase();
  const finalBadge = `<span class="${classForStatus(finalStatus)}">${labelForStatus(finalStatus)}</span>`;
  if (finalStatusObj.message && finalStatus === 'error') {
    errorMessages.push(`Final quiz: ${finalStatusObj.message}`);
  }
  const finalNote = (() => {
    switch (finalStatus) {
      case 'completed':
        return 'Ready';
      case 'processing':
        return 'Generating…';
      case 'pending':
        return 'Waiting to start';
      case 'error':
        return 'Needs attention';
      case 'skipped':
        return 'Disabled';
      default:
        return '';
    }
  })();

  const finalNoteStatus = ['completed', 'processing', 'pending', 'error', 'skipped'].includes(finalStatus)
    ? finalStatus
    : 'pending';
  const finalNoteText = finalNote || 'Status unknown';
  const finalContainerClass = `status-final status-final-${finalNoteStatus}`;
  const finalNoteClass = `status-final-note status-final-note-${finalNoteStatus}`;
  const finalLine = `
    <div class="${finalContainerClass}">
      <div class="status-final-info">
        <div class="status-final-label">Final quiz</div>
        <div class="${finalNoteClass}">${escapeHtml(finalNoteText)}</div>
      </div>
      <div class="status-final-badge">${finalBadge}</div>
    </div>
  `.trim();

  const updatedLabel = escapeHtml(`Updated ${formatRelativeTime(status?.updatedAt)}`);
  const errorBlock = errorMessages.length
    ? `<div class="status-errors"><div>Needs attention:</div><ul>${errorMessages.map(msg => `<li>${escapeHtml(msg)}</li>`).join('')}</ul></div>`
    : '';

  return `
    <div class="status-block">
      <div class="status-header">
        <div class="status-title">${videoTitle}</div>
      </div>
      ${progressMarkup}
      ${metricsMarkup}
      ${finalLine}
      <div class="status-updated">${updatedLabel}</div>
      ${errorBlock}
    </div>
  `.trim();
}

async function loadGenerationStatus() {
  const container = document.getElementById('statusContent');
  if (!container) return;

  updateStatusSummary('pending', 'Checking…');
  container.innerHTML = '<div class="status-placeholder">Checking current video...</div>';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.url.includes('youtube.com/watch')) {
      updateStatusSummary('skipped', 'Unavailable');
      container.innerHTML = '<div class="status-placeholder">Open a YouTube video to see quiz generation progress.</div>';
      return;
    }

    let videoId = null;
    try {
      const url = new URL(tab.url);
      videoId = url.searchParams.get('v');
    } catch (err) {
      console.warn('LearnTube: Could not parse video ID from URL', err);
    }

    const statusMap = await chrome.runtime.sendMessage({ type: 'GET_GENERATION_STATUS' }) || {};
    const currentStatus = videoId ? statusMap[videoId] : null;

    if (!currentStatus) {
      updateStatusSummary('pending', 'Waiting');
      container.innerHTML = '<div class="status-placeholder">No quiz activity recorded for this video yet.</div>';
      return;
    }

    const overallStatus = deriveOverallStatus(currentStatus);
    updateStatusSummary(overallStatus);
    container.innerHTML = renderCurrentStatus(currentStatus);
  } catch (error) {
    console.error('Error loading generation status:', error);
    updateStatusSummary('error', 'Error');
    container.innerHTML = '<div class="status-placeholder status-error">Unable to load quiz status.</div>';
  }
}

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
      btn.innerHTML = '✓ Progress Cleared';
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

document.getElementById('openInstallGuide').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({
    url: 'https://github.com/Sumit189/LearnTube-AI?tab=readme-ov-file#installation-unpacked-extension'
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

    // Reload the current YouTube tab to regenerate quizzes after 1 seconds
    setTimeout(() => {
      chrome.tabs.reload(targetTabId);
    }, 1000);

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
      setModelState('languageModel', { status: 'not-ready', message: 'Not on YouTube', canDownload: false });
      setModelState('summarizer', { status: 'not-ready', message: 'Not on YouTube', canDownload: false });
      updateModelStatus('languageModelStatus', 'not-ready', 'Not on YouTube', false);
      updateModelStatus('summarizerStatus', 'not-ready', 'Not on YouTube', false);
      updateDownloadModelsBtn();
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
      setModelState('languageModel', { status: 'not-ready', message: 'Refresh the YT tab to load LearnTube AI', canDownload: false });
      setModelState('summarizer', { status: 'not-ready', message: 'Refresh the YT tab to load LearnTube AI', canDownload: false });
      updateModelStatus('languageModelStatus', 'not-ready', 'Refresh the YT tab to load LearnTube AI', false);
      updateModelStatus('summarizerStatus', 'not-ready', 'Refresh the YT tab to load LearnTube AI', false);
      updateDownloadModelsBtn();
      return;
    }
    
    if (response) {
      setModelState('languageModel', response.languageModel);
      setModelState('summarizer', response.summarizer);
      updateModelStatus('languageModelStatus', response.languageModel.status, response.languageModel.message, response.languageModel.canDownload);
      updateModelStatus('summarizerStatus', response.summarizer.status, response.summarizer.message, response.summarizer.canDownload);
    } else {
      setModelState('languageModel', { status: 'not-ready', message: 'Refresh the YT tab to load LearnTube AI', canDownload: false });
      setModelState('summarizer', { status: 'not-ready', message: 'Refresh the YT tab to load LearnTube AI', canDownload: false });
      updateModelStatus('languageModelStatus', 'not-ready', 'Refresh the YT tab to load LearnTube AI', false);
      updateModelStatus('summarizerStatus', 'not-ready', 'Refresh the YT tab to load LearnTube AI', false);
    }
    updateDownloadModelsBtn();
    
  } catch (error) {
    console.error('Error checking model status:', error);
    setModelState('languageModel', { status: 'not-ready', message: 'Error checking', canDownload: false });
    setModelState('summarizer', { status: 'not-ready', message: 'Error checking', canDownload: false });
    updateModelStatus('languageModelStatus', 'not-ready', 'Error checking', false);
    updateModelStatus('summarizerStatus', 'not-ready', 'Error checking', false);
    updateDownloadModelsBtn();
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
    const isDownloadingMessage = typeof message === 'string' && message.toLowerCase().includes('download');
    if (status === 'checking' && isDownloadingMessage) {
      progressBar.style.display = 'flex';
    } else if (status !== 'checking') {
      progressBar.style.display = 'none';
    }
  }
}

if (downloadModelsBtn) {
  downloadModelsBtn.addEventListener('click', async () => {
    await downloadModel('languageModel', downloadModelsBtn);
  });
}

updateDownloadModelsBtn();

async function downloadModel(modelType, triggerButton = null) {
  const fallbackBtn = document.getElementById(`download${modelType.charAt(0).toUpperCase() + modelType.slice(1)}`);
  const downloadBtn = triggerButton || fallbackBtn || null;
  const statusElement = modelType === 'languageModel' ? 'languageModelStatus' : 'summarizerStatus';
  const companionType = modelType === 'languageModel' ? 'summarizer' : 'languageModel';
  const companionElement = companionType === 'languageModel' ? 'languageModelStatus' : 'summarizerStatus';
  const progressBar = document.getElementById(`${modelType}Progress`);
  const companionProgressBar = document.getElementById(`${companionType}Progress`);
  let checkInterval = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      alert('Please navigate to a YouTube video first to download models!');
      return;
    }

    if (downloadBtn && downloadBtn !== downloadModelsBtn) {
      downloadBtn.textContent = 'Downloading...';
      downloadBtn.disabled = true;
    }

    downloadInProgress = true;
    updateDownloadModelsBtn();

    updateModelStatus(statusElement, 'checking', 'Downloading models...', false);
    setModelState(modelType, { status: 'checking', message: 'Downloading models...', canDownload: false });

    updateModelStatus(companionElement, 'checking', 'Awaiting bundle...', false);
    setModelState(companionType, { status: 'checking', message: 'Awaiting bundle...', canDownload: false });

    if (progressBar) {
      progressBar.style.display = 'flex';
      const progressFill = progressBar.querySelector('.progress-fill');
      const progressText = progressBar.querySelector('.progress-text');
      progressFill.style.width = '0%';
      progressText.textContent = '0%';
    }

    if (companionProgressBar) {
      companionProgressBar.style.display = 'none';
    }

    await chrome.tabs.sendMessage(tab.id, {
      action: 'downloadModel',
      modelType
    });

    let checkCount = 0;
    const maxChecks = 60;

    checkInterval = setInterval(async () => {
      checkCount += 1;

      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'checkModelStatus' });

        if (response) {
          setModelState('languageModel', response.languageModel);
          setModelState('summarizer', response.summarizer);
          updateModelStatus('languageModelStatus', response.languageModel.status, response.languageModel.message, response.languageModel.canDownload);
          updateModelStatus('summarizerStatus', response.summarizer.status, response.summarizer.message, response.summarizer.canDownload);
          updateDownloadModelsBtn();

          const modelStatus = modelType === 'languageModel' ? response.languageModel : response.summarizer;

          if (modelStatus.status === 'ready') {
            if (progressBar) {
              const progressFill = progressBar.querySelector('.progress-fill');
              const progressText = progressBar.querySelector('.progress-text');
              progressFill.style.width = '100%';
              progressText.textContent = '100%';

              setTimeout(() => {
                progressBar.style.display = 'none';
              }, 1500);
            }

            downloadInProgress = false;
            updateDownloadModelsBtn();

            if (downloadBtn && downloadBtn !== downloadModelsBtn) {
              downloadBtn.style.display = 'none';
            }

            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }

            checkModelStatus();
          } else if (modelStatus.status === 'not-ready' && checkCount > 5) {
            updateModelStatus(statusElement, 'not-ready', 'Download failed', true);
            setModelState(modelType, { status: 'not-ready', message: 'Download failed', canDownload: true });

            if (progressBar) {
              progressBar.style.display = 'none';
            }

            downloadInProgress = false;
            updateDownloadModelsBtn();

            if (downloadBtn) {
              downloadBtn.textContent = 'Try Again';
              downloadBtn.disabled = false;
            }

            if (checkInterval) {
              clearInterval(checkInterval);
              checkInterval = null;
            }

            checkModelStatus();
          }
        }
      } catch (error) {
        console.error('LearnTube: Error checking model status:', error);
      }

      if (checkCount >= maxChecks) {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }

        if (progressBar) {
          progressBar.style.display = 'none';
        }

        setModelState(modelType, { status: 'not-ready', message: 'Download failed (timeout)', canDownload: true });
        updateModelStatus(statusElement, 'not-ready', 'Download timed out', true);

        downloadInProgress = false;
        updateDownloadModelsBtn();

        if (downloadBtn) {
          downloadBtn.textContent = 'Try Again';
          downloadBtn.disabled = false;
        }

        checkModelStatus();
      }
    }, 2000);

  } catch (error) {
    console.error('Error downloading model:', error);

    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }

    if (progressBar) {
      progressBar.style.display = 'none';
    }

    setModelState(modelType, { status: 'not-ready', message: 'Download failed', canDownload: true });
    updateModelStatus(statusElement, 'not-ready', 'Download failed', true);

    downloadInProgress = false;
    updateDownloadModelsBtn();

    if (downloadBtn) {
      downloadBtn.textContent = 'Try Again';
      downloadBtn.disabled = false;
    }

    alert('Error: Could not download model. Make sure you are on a YouTube video page.');
    checkModelStatus();
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
  shareText = `LearnTube AI Progress — "${videoTitle}"

Current video stats:
- Questions answered: ${totalQuestions}
- Correct answers: ${totalCorrect}
- Accuracy: ${accuracy}%

Keep learning with interactive quizzes from LearnTube AI.
Get the extension: https://github.com/sumit189/learntube-ai`;
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
      
  shareText = `LearnTube AI Progress Summary

Lifetime stats:
- Videos studied: ${totalVideos}
- Quizzes completed: ${totalQuizzes}
- Questions answered: ${totalQuestions}
- Correct answers: ${totalScore}
- Accuracy: ${accuracy}%

Keep learning with interactive quizzes from LearnTube AI.
Get the extension: https://github.com/sumit189/learntube-ai`;
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
loadGenerationStatus();

// Listen for storage changes and update progress in real-time
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.learntube_progress) {
    calculateStats(changes.learntube_progress.newValue || {});
  }
  if (areaName === 'local' && changes.learntube_generation_status) {
    loadGenerationStatus();
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
    setModelState(modelType, { status: 'checking', message: `Downloading ${progress}%...`, canDownload: false });

    if (downloadInProgress && downloadModelsBtn && modelType === 'languageModel') {
      downloadModelsBtn.style.display = 'block';
      downloadModelsBtn.disabled = true;
      downloadModelsBtn.textContent = progress < 100 ? `Downloading... ${progress}%` : 'Finishing download...';
      if (downloadModelsHelp) {
        downloadModelsHelp.style.display = 'block';
      }
    }

    updateDownloadModelsBtn();
  } else if (message.type === 'VIDEO_CHANGED') {
    // Refresh generation status when video changes
    loadGenerationStatus();
  }
  
  return true;
});

chrome.tabs.onActivated.addListener(() => {
  loadGenerationStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab?.active && changeInfo?.status === 'complete') {
    loadGenerationStatus();
  }
});

