let videoElement = null;
let transcriptData = null;
let currentSegmentIndex = 0;
let quizActive = false;
let videoId = null;
let finalQuizShown = false;
let videoSegments = [];
let monitorAttached = false;
let shownSegmentsSet = new Set();
let pendingSegmentTriggers = new Set();
let seekbarObserver = null;
let indicatorsAllowed = false;
let indicatorsAdded = false;
const DEFAULT_USER_SETTINGS = { questionCount: 1, autoQuiz: true, finalQuizEnabled: true, enabled: true, theme: 'dark', analyticsEnabled: true };
let userSettings = { ...DEFAULT_USER_SETTINGS };
let finalQuizQuestions = null;
let finalQuizGenerating = false;
let finalQuizGenerationPromise = null;
let transcriptProcessStarted = false;
let monitorCleanup = null;
let modelsInitialized = false;
let modelsInitializing = false;
let lastClearedVideoId = null;
const hashedVideoIdCache = new Map();

const ANALYTICS_LAST_ACTIVE_KEY = 'learntube_analytics_last_active';
const QUIZ_ANALYTICS_CONFIG = {
  FLUSH_DELAY_MS: 15000,
  MAX_BUFFERED_ANSWERS: 8
};

let quizAnalyticsState = {
  timeoutId: null,
  payload: null,
  bufferedAnswers: 0
};

if (typeof window !== 'undefined' && !window.__learntubeAnalyticsListenersAttached) {
  window.__learntubeAnalyticsListenersAttached = true;
  const flushHandler = () => flushQuizAnalytics(true);
  window.addEventListener('beforeunload', flushHandler);
  window.addEventListener('pagehide', flushHandler);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushQuizAnalytics(true);
    }
  });
}

function trackAnalyticsEvent(eventName, params = {}) {
  if (!eventName || userSettings.analyticsEnabled === false) {
    return;
  }

  if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }

  const message = {
    type: 'TRACK_ANALYTICS',
    event: eventName,
    params
  };

  try {
    const sendResult = chrome.runtime.sendMessage(message);
    if (typeof sendResult?.catch === 'function') {
      sendResult.catch(error => {
        if (isContextInvalidated(error)) {
          console.log('LearnTube: Analytics event skipped, extension reloaded');
        } else {
          console.warn('LearnTube: Unable to send analytics event:', error);
        }
      });
    }
  } catch (error) {
    if (isContextInvalidated(error)) {
      console.log('LearnTube: Analytics event skipped, extension reloaded');
    } else {
      console.warn('LearnTube: Unable to send analytics event:', error);
    }
  }
}

async function pingDailyAnalytics() {
  if (userSettings.analyticsEnabled === false) {
    return;
  }
  try {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const stored = await chrome.storage.local.get(ANALYTICS_LAST_ACTIVE_KEY);
    if (stored?.[ANALYTICS_LAST_ACTIVE_KEY] === key) {
      return;
    }
    await chrome.storage.local.set({ [ANALYTICS_LAST_ACTIVE_KEY]: key });
    trackAnalyticsEvent('extension_active', { cadence: 'daily' });
  } catch (error) {
    console.warn('LearnTube: Daily analytics ping skipped:', error);
  }
}

const CACHE_CONFIG = {
  LIMIT: 10,
  LRU_KEY: 'learntube_cache_lru',
  QUIZ_PREFIX: 'learntube_quiz_',
  TRANSCRIPT_PREFIX: 'learntube_transcript_'
};

const STATUS_STORAGE_KEY = 'learntube_generation_status';

const TRANSCRIPT_PROCESSING_CONFIG = {
  SUMMARY_CHUNK_CHAR_LIMIT: 4000,
  SUMMARY_MIN_CHUNK_CHAR_LIMIT: 1000,
  SUMMARY_COMBINED_CHAR_LIMIT: 6000,
  QUIZ_INPUT_CHAR_LIMIT: 8000,
  CHUNK_REDUCTION_RATIO: 0.7
};

let generationStatus = null;

const EXTENSION_INVALIDATED_TEXT = 'Extension context invalidated';
const FINAL_INDICATOR_SELECTOR = '.learntube-final-indicator';
const SEEK_BAR_SELECTORS = [
  '.ytp-progress-bar-container',
  '.ytp-progress-bar',
  '#progress-bar',
  '.ytp-chapter-container',
  '.ytp-chapters-container',
  '.ytp-progress-list',
  '.html5-progress-bar-container',
  '.html5-progress-bar'
];

function isContextInvalidated(error) {
  return Boolean(error?.message?.includes(EXTENSION_INVALIDATED_TEXT));
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isQuotaExceededError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return (error?.name === 'QuotaExceededError') || /quota ?exceeded/i.test(message);
}

function trimTextToLimit(text, limit) {
  if (!text || !Number.isFinite(limit) || limit <= 0) {
    return text || '';
  }
  if (text.length <= limit) {
    return text;
  }
  const trimmed = text.slice(0, limit).trimEnd();
  return `${trimmed}...`;
}

function splitTextIntoChunks(text, chunkSize) {
  if (!text || !Number.isFinite(chunkSize) || chunkSize <= 0) {
    return [];
  }
  const chunks = [];
  let cursor = 0;
  const cleanText = text.trim();

  while (cursor < cleanText.length) {
    const sliceEnd = Math.min(cursor + chunkSize, cleanText.length);
    let end = sliceEnd;

    if (sliceEnd < cleanText.length) {
      const newlineIndex = cleanText.lastIndexOf('\n', sliceEnd);
      const sentenceIndex = cleanText.lastIndexOf('. ', sliceEnd);
      const boundary = Math.max(newlineIndex, sentenceIndex);
      if (boundary > cursor + Math.floor(chunkSize * 0.4)) {
        end = boundary + 1;
      }
    }

    if (end <= cursor) {
      end = Math.min(cursor + chunkSize, cleanText.length);
    }

    const chunk = cleanText.slice(cursor, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    cursor = end;
  }

  return chunks;
}

function hasFinalQuizData() {
  return isNonEmptyArray(finalQuizQuestions);
}

function getExistingFinalQuiz() {
  return hasFinalQuizData() ? finalQuizQuestions : null;
}

function logStorageError(context, error) {
  if (isContextInvalidated(error)) {
    console.log(`LearnTube: ${context} skipped, extension reloaded`);
  } else {
    console.error(`LearnTube: ${context}:`, error);
  }
}

function safeRuntimeSendMessage(message) {
  if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }
  try {
    const result = chrome.runtime.sendMessage(message);
    if (typeof result?.catch === 'function') {
      result.catch(() => { });
    }
  } catch (error) {
    if (!isContextInvalidated(error)) {
      console.warn('LearnTube: Runtime message failed:', error);
    }
  }
}

async function getHashedVideoId(rawVideoId) {
  if (!rawVideoId) {
    return 'hash_unavailable';
  }
  if (hashedVideoIdCache.has(rawVideoId)) {
    return hashedVideoIdCache.get(rawVideoId);
  }
  try {
    if (!crypto?.subtle?.digest) {
      throw new Error('subtle crypto unavailable');
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(rawVideoId);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(digest));
    const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
    hashedVideoIdCache.set(rawVideoId, hashHex);
    return hashHex;
  } catch (error) {
    console.warn('LearnTube: Failed to hash video id for analytics:', error);
    const fallback = 'hash_unavailable';
    hashedVideoIdCache.set(rawVideoId, fallback);
    return fallback;
  }
}

async function touchCache(videoId) {
  if (!videoId) return;
  try {
    const result = await chrome.storage.local.get(CACHE_CONFIG.LRU_KEY);
    const currentList = Array.isArray(result?.[CACHE_CONFIG.LRU_KEY])
      ? result[CACHE_CONFIG.LRU_KEY]
      : [];

    const updatedList = [videoId, ...currentList.filter(id => id !== videoId)];
    const keysToRemove = [];

    while (updatedList.length > CACHE_CONFIG.LIMIT) {
      const evictedId = updatedList.pop();
      if (!evictedId) continue;
      keysToRemove.push(
        `${CACHE_CONFIG.QUIZ_PREFIX}${evictedId}`,
        `${CACHE_CONFIG.TRANSCRIPT_PREFIX}${evictedId}`
      );
    }

    await chrome.storage.local.set({ [CACHE_CONFIG.LRU_KEY]: updatedList });

    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (error) {
    logStorageError('Error updating cache order', error);
  }
}

function getCurrentVideoTitle() {
  const selectors = [
    'h1.title yt-formatted-string',
    'h1.title'
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const titleText = element?.textContent?.trim();
    if (titleText) return titleText;
  }
  const fallback = document.title?.replace(' - YouTube', '').trim();
  return fallback || 'Unknown Video';
}

function computeOverallGenerationStatus(statusObj) {
  if (!statusObj) return 'idle';
  const segments = Array.isArray(statusObj.segments) ? statusObj.segments : [];
  const hasError = segments.some(seg => seg.status === 'error') || (statusObj.final && statusObj.final.status === 'error');
  if (hasError) return 'error';

  const segmentsCompleted = segments.length > 0
    ? segments.every(seg => seg.status === 'completed' || seg.status === 'skipped')
    : true;

  const finalStatus = statusObj.final?.status || 'skipped';
  const finalCompleted = finalStatus === 'completed' || finalStatus === 'skipped';

  return segmentsCompleted && finalCompleted ? 'completed' : 'processing';
}

async function persistGenerationStatus() {
  if (!videoId || !generationStatus) return;
  try {
    generationStatus.videoTitle = getCurrentVideoTitle() || generationStatus.videoTitle || 'Unknown Video';
    generationStatus.updatedAt = Date.now();
    generationStatus.overallStatus = computeOverallGenerationStatus(generationStatus);

    const existing = await chrome.storage.local.get(STATUS_STORAGE_KEY);
    const allStatuses = existing?.[STATUS_STORAGE_KEY] || {};
    allStatuses[videoId] = generationStatus;
    await chrome.storage.local.set({ [STATUS_STORAGE_KEY]: allStatuses });
  } catch (error) {
    logStorageError('Error saving generation status', error);
  }
}

async function loadGenerationStatusFromStorage(currentVideoId) {
  if (!currentVideoId) return null;
  try {
    const result = await chrome.storage.local.get(STATUS_STORAGE_KEY);
    const stored = result?.[STATUS_STORAGE_KEY]?.[currentVideoId];
    if (stored) {
      generationStatus = {
        ...stored,
        videoId: currentVideoId,
        videoTitle: getCurrentVideoTitle() || stored.videoTitle || 'Unknown Video'
      };
      generationStatus.overallStatus = computeOverallGenerationStatus(generationStatus);
      generationStatus.updatedAt = Date.now();
      await persistGenerationStatus();
      return generationStatus;
    }
  } catch (error) {
    logStorageError('Error loading generation status', error);
  }
  generationStatus = null;
  return null;
}

function createInitialGenerationStatus(segmentCount) {
  const finalEnabled = Boolean(userSettings.finalQuizEnabled);
  return {
    videoId,
    videoTitle: getCurrentVideoTitle(),
    updatedAt: Date.now(),
    overallStatus: 'processing',
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      index,
      status: 'pending',
      questionCount: 0,
      target: userSettings.questionCount || 1,
      message: ''
    })),
    final: {
      status: finalEnabled ? 'pending' : 'skipped',
      questionCount: 0,
      target: CONFIG.FINAL_QUIZ_QUESTIONS_MIN,
      message: ''
    }
  };
}

function ensureSegmentStatusEntry(index) {
  if (!generationStatus) return;
  if (!Array.isArray(generationStatus.segments)) {
    generationStatus.segments = [];
  }
  if (!generationStatus.segments[index]) {
    generationStatus.segments[index] = {
      index,
      status: 'pending',
      questionCount: 0,
      target: userSettings.questionCount || 1,
      message: ''
    };
  }
}

async function markSegmentStatus(index, status, questionCount = 0, message = '') {
  if (!generationStatus) return;
  ensureSegmentStatusEntry(index);
  const segmentStatus = generationStatus.segments[index];
  segmentStatus.status = status;
  segmentStatus.questionCount = typeof questionCount === 'number' ? questionCount : segmentStatus.questionCount;
  segmentStatus.target = userSettings.questionCount || segmentStatus.target || 1;
  segmentStatus.message = message || '';
  generationStatus.segments[index] = segmentStatus;
  await persistGenerationStatus();
}

async function updateFinalTarget(targetCount) {
  if (!generationStatus || !generationStatus.final) return;
  generationStatus.final.target = targetCount;
  if (generationStatus.final.status === 'skipped') {
    generationStatus.final.status = 'pending';
  }
  await persistGenerationStatus();
}

async function markFinalStatus(status, questionCount = 0, message = '') {
  if (!generationStatus || !generationStatus.final) return;
  generationStatus.final.status = status;
  generationStatus.final.questionCount = questionCount;
  generationStatus.final.message = message || '';
  await persistGenerationStatus();
}

async function clearGenerationStatus(videoIdToClear) {
  if (!videoIdToClear) return;
  try {
    const result = await chrome.storage.local.get(STATUS_STORAGE_KEY);
    const statuses = result?.[STATUS_STORAGE_KEY] || {};
    if (statuses[videoIdToClear]) {
      delete statuses[videoIdToClear];
      await chrome.storage.local.set({ [STATUS_STORAGE_KEY]: statuses });
    }
  } catch (error) {
    logStorageError('Error clearing generation status', error);
  }
  if (videoIdToClear === videoId) {
    generationStatus = null;
  }
}

async function ensureFinalQuizReady(segments, options = {}) {
  const { cacheAfter = false, allowGeneration = true } = options;

  if (!userSettings.finalQuizEnabled) {
    return getExistingFinalQuiz();
  }

  const usableSegments = isNonEmptyArray(segments) ? segments : videoSegments;

  if (!isNonEmptyArray(usableSegments)) {
    return getExistingFinalQuiz();
  }

  if (hasFinalQuizData()) {
    if ((generationStatus?.final?.status || '').toLowerCase() !== 'completed') {
      await markFinalStatus('completed', finalQuizQuestions.length, '');
    }
    return finalQuizQuestions;
  }

  if (finalQuizGenerationPromise) {
    try {
      await finalQuizGenerationPromise;
    } catch (error) {
      // Error already logged inside the generation routine
    }
    return getExistingFinalQuiz();
  }

  if (!allowGeneration) {
    return null;
  }

  const allText = usableSegments.map(s => s.text).join(' ');
  const totalDuration = usableSegments[usableSegments.length - 1]?.end || videoElement?.duration || 0;
  const randomTarget = Math.floor(Math.random() * (CONFIG.FINAL_QUIZ_QUESTIONS_MAX - CONFIG.FINAL_QUIZ_QUESTIONS_MIN + 1)) + CONFIG.FINAL_QUIZ_QUESTIONS_MIN;
  const targetCount = Number.isFinite(generationStatus?.final?.target) && generationStatus.final.target > 0
    ? generationStatus.final.target
    : randomTarget;

  finalQuizGenerating = true;

  finalQuizGenerationPromise = (async () => {
    try {
      await updateFinalTarget(targetCount);
      await markFinalStatus('processing', 0, '');

      const summary = await summarizeTranscript(allText);
      const summaryText = summary || trimTextToLimit(allText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
      const finalSegment = { start: 0, end: totalDuration, text: summaryText };
      const generated = await generateQuiz(finalSegment, targetCount);

      if (!generated || generated.length === 0) {
        throw new Error('Final quiz generation returned no questions');
      }

      finalQuizQuestions = generated;
      await markFinalStatus('completed', generated.length, '');
      if (videoId) {
        await enqueueQuizGenerationEvent(videoId, {
          quiz_type: 'final',
          segment_index: null,
          question_count: generated.length,
          status: 'completed',
          flushImmediately: true
        });
      }

      if (videoId && cacheAfter) {
        await cacheAllQuizzes(videoId, videoSegments);
      }

      if (indicatorsAllowed && indicatorsAdded && !document.querySelector(FINAL_INDICATOR_SELECTOR)) {
        setTimeout(() => {
          indicatorsAdded = false;
          addQuizIndicatorsToSeekbar();
        }, 0);
      }

      return finalQuizQuestions;
    } catch (error) {
      const message = error?.message || 'Final quiz generation failed';
      console.error('LearnTube: Final quiz generation failed:', message);
      finalQuizQuestions = null;
      await markFinalStatus('error', 0, message);
      if (videoId) {
        await enqueueQuizGenerationEvent(videoId, {
          quiz_type: 'final',
          segment_index: null,
          question_count: 0,
          status: 'error',
          error_message: message,
          flushImmediately: true
        });
      }
      throw error;
    } finally {
      finalQuizGenerating = false;
    }
  })();

  try {
    return await finalQuizGenerationPromise;
  } finally {
    finalQuizGenerationPromise = null;
  }
}

function resetVideoState() {
  if (typeof monitorCleanup === 'function') {
    monitorCleanup();
    monitorCleanup = null;
  }

  monitorAttached = false;

  videoId = null;
  currentSegmentIndex = 0;
  quizActive = false;
  finalQuizShown = false;
  videoSegments = [];
  shownSegmentsSet.clear();
  pendingSegmentTriggers.clear();
  indicatorsAllowed = false;
  indicatorsAdded = false;
  finalQuizQuestions = null;
  finalQuizGenerating = false;
  transcriptProcessStarted = false;
  generationStatus = null;

  clearSeekbarIndicators();
  removeOverlay();
}

async function loadUserSettings() {
  try {
    const result = await chrome.storage.local.get('learntube_settings');
    if (result?.learntube_settings) {
      userSettings = { ...DEFAULT_USER_SETTINGS, ...result.learntube_settings };
    }
  } catch (error) {
    if (isContextInvalidated(error)) {
      console.log('LearnTube: Extension reloaded, using default settings');
    } else {
      console.error('LearnTube: Error loading settings:', error);
    }
  }
  if (!userSettings.theme) {
    userSettings.theme = DEFAULT_USER_SETTINGS.theme;
  }
}

function computeVideoProgressTotals(videoProgress) {
  let correct = 0;
  let incorrect = 0;

  if (!videoProgress || typeof videoProgress !== 'object') {
    return { correct: 0, incorrect: 0, total: 0 };
  }

  const segments = Array.isArray(videoProgress.segments) ? videoProgress.segments : [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const score = Number(segment.score) || 0;
    const total = Number(segment.total) || 0;
    correct += score;
    incorrect += Math.max(total - score, 0);
  }

  const final = videoProgress.final;
  if (final && typeof final === 'object') {
    const score = Number(final.score) || 0;
    const total = Number(final.total) || 0;
    correct += score;
    incorrect += Math.max(total - score, 0);
  }

  return { correct, incorrect, total: correct + incorrect };
}

function computeUserProgressTotals(progressData) {
  const totals = { correct: 0, incorrect: 0, total: 0 };
  if (!progressData || typeof progressData !== 'object') {
    return totals;
  }

  for (const key of Object.keys(progressData)) {
    const videoTotals = computeVideoProgressTotals(progressData[key]);
    totals.correct += videoTotals.correct;
    totals.incorrect += videoTotals.incorrect;
  }

  totals.total = totals.correct + totals.incorrect;
  return totals;
}

function flushQuizAnalytics(force = false) {
  if (quizAnalyticsState.timeoutId) {
    clearTimeout(quizAnalyticsState.timeoutId);
    quizAnalyticsState.timeoutId = null;
  }

  if (!quizAnalyticsState.payload || userSettings.analyticsEnabled === false) {
    quizAnalyticsState.payload = null;
    quizAnalyticsState.bufferedAnswers = 0;
    return;
  }

  const { userTotals, generationEvents } = quizAnalyticsState.payload;
  const generationList = Array.isArray(generationEvents) ? generationEvents : [];
  const totals = userTotals || {};

  const answeredCount = Number.isFinite(totals.total) ? totals.total : 0;
  const hasAnswered = answeredCount > 0;

  if (!hasAnswered && !generationList.length) {
    quizAnalyticsState.payload = null;
    quizAnalyticsState.bufferedAnswers = 0;
    return;
  }

  trackAnalyticsEvent('quiz_progress_snapshot', {
    user_correct_total: totals.correct || 0,
    user_incorrect_total: totals.incorrect || 0,
    user_total_answered: answeredCount,
    generation_event_count: generationList.length,
    generation_events: generationList,
    flush_reason: force ? 'forced' : 'scheduled'
  });

  quizAnalyticsState.payload = null;
  quizAnalyticsState.bufferedAnswers = 0;
}

function enqueueQuizAnalyticsUpdate(_videoId, _segmentIndex, _isCorrect, isFinal, _videoTotals, userTotals) {
  if (userSettings.analyticsEnabled === false) {
    return;
  }

  const payload = quizAnalyticsState.payload || {
    userTotals: { correct: 0, incorrect: 0, total: 0 },
    generationEvents: []
  };

  if (!Array.isArray(payload.generationEvents)) {
    payload.generationEvents = [];
  }

  payload.userTotals = {
    correct: userTotals.correct,
    incorrect: userTotals.incorrect,
    total: userTotals.total
  };

  quizAnalyticsState.payload = payload;
  quizAnalyticsState.bufferedAnswers += 1;

  if (quizAnalyticsState.timeoutId) {
    clearTimeout(quizAnalyticsState.timeoutId);
  }

  quizAnalyticsState.timeoutId = setTimeout(() => flushQuizAnalytics(false), QUIZ_ANALYTICS_CONFIG.FLUSH_DELAY_MS);

  if (quizAnalyticsState.bufferedAnswers >= QUIZ_ANALYTICS_CONFIG.MAX_BUFFERED_ANSWERS || isFinal) {
    flushQuizAnalytics(false);
  }
}

async function enqueueQuizGenerationEvent(videoId, details = {}) {
  if (!videoId || userSettings.analyticsEnabled === false) {
    return;
  }

  const payload = quizAnalyticsState.payload || {
    userTotals: { correct: 0, incorrect: 0, total: 0 },
    generationEvents: []
  };

  if (!Array.isArray(payload.generationEvents)) {
    payload.generationEvents = [];
  }

  const hashedVideoId = await getHashedVideoId(videoId);

  payload.generationEvents.push({
    video_id_hash: hashedVideoId,
    quiz_type: details.quiz_type || 'segment',
    segment_index: typeof details.segment_index === 'number' ? details.segment_index : null,
    question_count: typeof details.question_count === 'number' ? details.question_count : null,
    status: details.status || 'completed',
    error_message: details.error_message || '',
    recorded_at: Date.now()
  });

  quizAnalyticsState.payload = payload;
  quizAnalyticsState.bufferedAnswers += 1;

  if (quizAnalyticsState.timeoutId) {
    clearTimeout(quizAnalyticsState.timeoutId);
  }

  quizAnalyticsState.timeoutId = setTimeout(() => flushQuizAnalytics(false), QUIZ_ANALYTICS_CONFIG.FLUSH_DELAY_MS);

  if (quizAnalyticsState.bufferedAnswers >= QUIZ_ANALYTICS_CONFIG.MAX_BUFFERED_ANSWERS || details.flushImmediately) {
    flushQuizAnalytics(details.flushImmediately === true);
  }
}

async function updateProgress(videoId, segmentIndex, isCorrect, isFinal = false) {
  try {
    const result = await chrome.storage.local.get('learntube_progress');
    const progress = result.learntube_progress || {};

    if (!progress[videoId]) {
      progress[videoId] = {
        segments: [],
        final: { score: 0, total: 0 }
      };
    }

    if (isFinal) {
      progress[videoId].final.total++;
      if (isCorrect) progress[videoId].final.score++;
    } else {
      if (!progress[videoId].segments[segmentIndex]) {
        progress[videoId].segments[segmentIndex] = { score: 0, total: 0 };
      }
      progress[videoId].segments[segmentIndex].total++;
      if (isCorrect) progress[videoId].segments[segmentIndex].score++;
    }

    const videoTotals = computeVideoProgressTotals(progress[videoId]);
    const userTotals = computeUserProgressTotals(progress);

    await chrome.storage.local.set({ learntube_progress: progress });

    enqueueQuizAnalyticsUpdate(videoId, segmentIndex, isCorrect, isFinal, videoTotals, userTotals);
  } catch (error) {
    if (isContextInvalidated(error)) {
      console.log('LearnTube: Extension reloaded, progress not saved');
    } else {
      console.error('LearnTube: Error updating progress:', error);
    }
  }
}

window.learntubeCloseQuiz = () => {
  removeOverlay();
  quizActive = false;
  const video = videoElement || document.querySelector('video');
  if (video) {
    video.play();
  }
};

const CONFIG = {
  SEGMENT_DURATION: 180,
  MIN_QUESTIONS_PER_SEGMENT: 1,
  MAX_QUESTIONS_PER_SEGMENT: 2,
  FINAL_QUIZ_QUESTIONS_MIN: 3,
  FINAL_QUIZ_QUESTIONS_MAX: 5,
  FINAL_QUIZ_TRIGGER_PERCENTAGE: 0.92
};

function extractVideoId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('v');
}

function closeTranscriptPanel() {
  const closeBtn = document.querySelector(
    'button[aria-label*="Hide transcript" i], button[aria-label*="Close transcript" i]'
  );
  if (closeBtn) {
    closeBtn.click();
    return;
  }
}

function isTranscriptPanelOpen() {
  try {
    // Get all potential panel containers
    const panels = Array.from(document.querySelectorAll('ytd-panel, ytd-engagement-panel-section-list-renderer'));

    // Find the first visible panel that contains the word "Transcript"
    const transcriptPanel = panels.find(panel => {
      if (!panel || !panel.innerText) return false;
      const text = panel.innerText.toLowerCase();
      return text.includes('transcript') && panel.offsetParent !== null;
    });

    // Returns true if such a panel exists and is visible
    return Boolean(transcriptPanel);
  } catch (err) {
    console.error('Error detecting transcript panel:', err);
    return false;
  }
}

async function clickShowTranscript(retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const showBtn = document.querySelector('button[aria-label="Show transcript"]');
    if (showBtn) {
      showBtn.click();
      await new Promise(r => setTimeout(r, 2000)); // wait for panel to load
      return true; // clicked successfully
    }
    await new Promise(r => setTimeout(r, delay)); // wait before retrying
  }
  return false;
}


async function getTranscript() {
  try {
    console.log('LearnTube: Fetching transcript...');
    const wasAlreadyOpen = isTranscriptPanelOpen();

    // Open transcript panel only if it's hidden
    if (!wasAlreadyOpen) {
      await clickShowTranscript();
    }

    const segments = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (!segments.length) {
      console.warn('No transcript found.');
      return null;
    }

    const rawTranscript = Array.from(segments).map(seg => ({
      time: seg.querySelector('.segment-timestamp')?.innerText?.trim(),
      text: seg.querySelector('.segment-text')?.innerText?.trim(),
    }));

    // Convert to required format
    const transcript = [];
    for (let i = 0; i < rawTranscript.length; i++) {
      const current = rawTranscript[i];
      if (!current.time || !current.text) continue;

      const timeMatch = current.time.match(/(\d+):(\d+)(?::(\d+))?/);
      if (!timeMatch) continue;

      let hours = 0, minutes = 0, seconds = 0;
      if (typeof timeMatch[3] !== 'undefined') {
        hours = parseInt(timeMatch[1]);
        minutes = parseInt(timeMatch[2]);
        seconds = parseInt(timeMatch[3]);
      } else {
        minutes = parseInt(timeMatch[1]);
        seconds = parseInt(timeMatch[2]);
      }

      const start = hours * 3600 + minutes * 60 + seconds;
      const next = rawTranscript[i + 1];
      let end = start + 3;

      if (next && next.time) {
        const nextTimeMatch = next.time.match(/(\d+):(\d+)(?::(\d+))?/);
        if (nextTimeMatch) {
          let nextHours = 0, nextMinutes = 0, nextSeconds = 0;
          if (typeof nextTimeMatch[3] !== 'undefined') {
            nextHours = parseInt(nextTimeMatch[1]);
            nextMinutes = parseInt(nextTimeMatch[2]);
            nextSeconds = parseInt(nextTimeMatch[3]);
          } else {
            nextMinutes = parseInt(nextTimeMatch[1]);
            nextSeconds = parseInt(nextTimeMatch[2]);
          }
          end = nextHours * 3600 + nextMinutes * 60 + nextSeconds;
        }
      }

      transcript.push({
        start: start,
        end: end,
        duration: end - start,
        text: current.text
      });
    }

    if (!wasAlreadyOpen) {
      // close after 1 seconds
      setTimeout(closeTranscriptPanel, 1000);
    }
    return transcript.length > 0 ? transcript : null;

  } catch (err) {
    console.error("LearnTube: Error getting transcript:", err);
    return null;
  }
}

function segmentTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    console.warn('LearnTube: segmentTranscript - empty or invalid transcript');
    return [];
  }

  const last = transcript.at(-1);
  const videoDuration = videoElement?.duration || 0;
  const transcriptEnd = last ? last.start + (last.duration || 0) : 0;
  const totalDuration = Math.max(videoDuration, transcriptEnd);
  const fallbackEnd = transcriptEnd || videoDuration;

  const {
    FINAL_QUIZ_TRIGGER_PERCENTAGE = 0.92,
    SEGMENT_DURATION = 180
  } = CONFIG || {};

  const effectiveTotal = totalDuration || fallbackEnd;
  const cutoffTime = effectiveTotal * FINAL_QUIZ_TRIGGER_PERCENTAGE;
  const minGapBeforeFinalQuiz = Math.min(90, Math.max(30, effectiveTotal * 0.15));

  const usableWindow = Math.max(0, cutoffTime - minGapBeforeFinalQuiz);
  const transcriptText = transcript.map(entry => entry.text).join(' ');

  if (usableWindow <= 30) {
    console.log('LearnTube: segmentTranscript - single segment fallback (short video)');
    return [{
      start: 0,
      end: fallbackEnd,
      text: transcriptText,
      entries: transcript
    }];
  }

  const desiredSegments = Math.max(1, Math.round(usableWindow / SEGMENT_DURATION));
  const rawSegmentDuration = usableWindow / desiredSegments;
  const clampedDuration = Math.max(60, Math.min(360, rawSegmentDuration));

  const segments = [];
  let segStart = 0;
  let tIdx = 0;

  while (segStart < usableWindow) {
    const segEnd = Math.min(segStart + clampedDuration, usableWindow);
    const entries = [];

    while (tIdx < transcript.length && transcript[tIdx].start < segEnd) {
      const entry = transcript[tIdx];
      if (entry.start >= segStart) entries.push(entry);
      tIdx++;
    }

    if (entries.length) {
      const lastEntry = entries.at(-1);
      const actualEnd = lastEntry.start + (lastEntry.duration || 0);

      segments.push({
        start: segStart,
        end: actualEnd,
        text: entries.map(e => e.text).join(' '),
        entries
      });
    }

    segStart += clampedDuration;
  }

  if (segments.length === 0) {
    console.log('LearnTube: segmentTranscript - fallback to full transcript segment');
    return [{
      start: 0,
      end: fallbackEnd,
      text: transcriptText,
      entries: transcript
    }];
  }

  console.log(`LearnTube: segmentTranscript - created ${segments.length} segments`);
  return segments;
}


async function handleSegmentGeneration(segment, index) {
  const questionTarget = userSettings.questionCount || 1;
  segment.status = 'processing';
  segment.errorMessage = '';
  await markSegmentStatus(index, 'processing', 0, '');
  updateSeekbarIndicator(index);

  try {
    const questions = await generateQuiz(segment, questionTarget);
    segment.questions = questions;
    segment.status = 'completed';
    segment.errorMessage = '';
    await markSegmentStatus(index, 'completed', questions.length, '');
    if (videoId) {
      await enqueueQuizGenerationEvent(videoId, {
        quiz_type: 'segment',
        segment_index: index,
        question_count: questions.length,
        status: 'completed'
      });
    }
    updateSeekbarIndicator(index);
    addIndicatorForSegment(index);
    if (pendingSegmentTriggers.has(index)) {
      pendingSegmentTriggers.delete(index);
      setTimeout(() => {
        if (!userSettings.enabled || !userSettings.autoQuiz) {
          return;
        }
        const displayed = autoShowSegmentQuiz(index);
        if (!displayed) {
          pendingSegmentTriggers.add(index);
        }
      }, 0);
    }
  } catch (error) {
    const message = error?.message || 'Quiz generation failed';
    console.error(`LearnTube: Quiz generation failed for segment ${index + 1}:`, message);
    segment.questions = [];
    segment.status = 'error';
    segment.errorMessage = message;
    await markSegmentStatus(index, 'error', 0, message);
    updateSeekbarIndicator(index);
    pendingSegmentTriggers.delete(index);
    if (videoId) {
      await enqueueQuizGenerationEvent(videoId, {
        quiz_type: 'segment',
        segment_index: index,
        question_count: 0,
        status: 'error',
        error_message: message
      });
    }
  }
}

function autoShowSegmentQuiz(index) {
  const segment = videoSegments[index];
  if (!segment || !Array.isArray(segment.questions) || segment.questions.length === 0) {
    return false;
  }
  if (!userSettings.enabled || !userSettings.autoQuiz) {
    return false;
  }
  if (quizActive) {
    return false;
  }

  if (!videoElement) {
    videoElement = document.querySelector('video');
    if (!videoElement) {
      return false;
    }
  }

  const targetTime = Number.isFinite(segment.end) ? segment.end : segment.start;
  if (videoElement && Number.isFinite(targetTime)) {
    const duration = Number.isFinite(videoElement.duration) ? videoElement.duration : null;
    const epsilon = 0.1;
    let adjusted = Math.max(0, targetTime - epsilon);
    if (duration && duration > 0) {
      adjusted = Math.min(adjusted, Math.max(0, duration - epsilon));
    }
    try {
      videoElement.currentTime = adjusted;
    } catch (error) {
      console.warn('LearnTube: Unable to adjust playback position for quiz:', error);
    }
  }

  pendingSegmentTriggers.delete(index);
  shownSegmentsSet.add(index);
  videoElement.pause();
  showQuiz(segment.questions, index);
  return true;
}

async function pregenerateAllQuizzes() {
  if (videoSegments.length === 0) return;

  const currentVideoId = extractVideoId();
  const questionTarget = userSettings.questionCount || 1;

  videoSegments.forEach((segment, index) => {
    if (!segment) return;
    segment.status = segment.status || 'pending';
    segment.errorMessage = segment.errorMessage || '';
    ensureSegmentStatusEntry(index);
    if (generationStatus?.segments?.[index]) {
      generationStatus.segments[index].target = questionTarget;
    }
  });

  if (!generationStatus || generationStatus.videoId !== currentVideoId || !generationStatus.segments || generationStatus.segments.length !== videoSegments.length) {
    generationStatus = createInitialGenerationStatus(videoSegments.length);
  }

  generationStatus.videoId = currentVideoId;
  generationStatus.videoTitle = getCurrentVideoTitle();
  generationStatus.segments = videoSegments.map((segment, index) => {
    const existing = generationStatus?.segments?.[index] || {
      index,
      status: 'pending',
      questionCount: 0,
      target: questionTarget,
      message: ''
    };
    if (segment?.questions?.length) {
      return {
        ...existing,
        status: 'completed',
        questionCount: segment.questions.length,
        message: ''
      };
    }
    if (segment?.status === 'error') {
      return {
        ...existing,
        status: 'error',
        questionCount: 0,
        message: segment.errorMessage || 'Quiz generation failed'
      };
    }
    return {
      ...existing,
      status: existing.status === 'completed' ? 'completed' : 'pending',
      questionCount: existing.questionCount || 0,
      message: existing.message || ''
    };
  });

  if (!generationStatus.final) {
    generationStatus.final = {
      status: userSettings.finalQuizEnabled ? 'pending' : 'skipped',
      questionCount: finalQuizQuestions?.length || 0,
      target: CONFIG.FINAL_QUIZ_QUESTIONS_MIN,
      message: ''
    };
  } else {
    if (!userSettings.finalQuizEnabled) {
      generationStatus.final.status = 'skipped';
      generationStatus.final.questionCount = 0;
      generationStatus.final.message = '';
    } else if (finalQuizQuestions?.length) {
      generationStatus.final.status = 'completed';
      generationStatus.final.questionCount = finalQuizQuestions.length;
      generationStatus.final.message = '';
    }
  }

  await persistGenerationStatus();

  let finalQuizPromise = null;
  if (userSettings.finalQuizEnabled) {
    finalQuizPromise = ensureFinalQuizReady(videoSegments, { cacheAfter: false }).catch(error => {
      console.error('LearnTube: Final quiz generation failed during pregeneration:', error);
      return null;
    });
  }

  if (!indicatorsAllowed) {
    indicatorsAllowed = true;
  }

  if (videoSegments.length > 0) {
    await handleSegmentGeneration(videoSegments[0], 0);
  }

  const batchSize = 3;
  for (let i = 1; i < videoSegments.length; i += batchSize) {
    const batch = [];
    const end = Math.min(i + batchSize, videoSegments.length);

    for (let j = i; j < end; j++) {
      const segment = videoSegments[j];
      if (!segment) continue;
      batch.push(handleSegmentGeneration(segment, j));
    }

    await Promise.all(batch);
    if (end < videoSegments.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (finalQuizPromise) {
    await finalQuizPromise;
  }

  await persistGenerationStatus();
  await cacheAllQuizzes(currentVideoId, videoSegments);
}

async function cacheTranscript(videoId, transcript) {
  if (!videoId || !transcript) return;
  const key = `${CACHE_CONFIG.TRANSCRIPT_PREFIX}${videoId}`;
  try {
    await chrome.storage.local.set({ [key]: transcript });
    await touchCache(videoId);
  } catch (error) {
    logStorageError('Error caching transcript', error);
  }
}

async function getCachedTranscript(videoId) {
  if (!videoId) return null;
  const key = `${CACHE_CONFIG.TRANSCRIPT_PREFIX}${videoId}`;
  try {
    const result = await chrome.storage.local.get(key);
    if (result && result[key]) {
      await touchCache(videoId);
      return result[key];
    }
  } catch (error) {
    logStorageError('Error loading cached transcript', error);
  }
  return null;
}

async function cacheAllQuizzes(videoId, segments) {
  if (!videoId || !Array.isArray(segments)) return;
  const key = `${CACHE_CONFIG.QUIZ_PREFIX}${videoId}`;
  try {
    const statusSnapshot = generationStatus ? JSON.parse(JSON.stringify(generationStatus)) : null;

    const cacheData = {
      version: '1.1',
      timestamp: Date.now(),
      segmentCount: segments.length,
      segments,
      finalQuiz: finalQuizQuestions,
      statusSnapshot
    };

    await chrome.storage.local.set({ [key]: cacheData });
    await touchCache(videoId);

    console.log(`LearnTube: Cached ${segments.length} segments`);
  } catch (error) {
    logStorageError('Error caching quizzes', error);
  }
}

async function getCachedQuizzes(videoId) {
  if (!videoId) return null;
  const key = `${CACHE_CONFIG.QUIZ_PREFIX}${videoId}`;
  try {
    const result = await chrome.storage.local.get(key);
    let cacheData = result ? result[key] : null;

    if (!cacheData) return null;

    if (!cacheData.version || !cacheData.segments) {
      console.log('LearnTube: Invalid or outdated cache format, clearing cache');
      await clearCachedData(videoId);
      return null;
    }

    await touchCache(videoId);
    return cacheData;
  } catch (error) {
    logStorageError('Error loading cached quizzes', error);
    return null;
  }
}

async function clearCachedData(videoId) {
  if (!videoId) return;
  const quizKey = `${CACHE_CONFIG.QUIZ_PREFIX}${videoId}`;
  const transcriptKey = `${CACHE_CONFIG.TRANSCRIPT_PREFIX}${videoId}`;

  try {
    await chrome.storage.local.remove([quizKey, transcriptKey]);

    const result = await chrome.storage.local.get(CACHE_CONFIG.LRU_KEY);
    if (Array.isArray(result?.[CACHE_CONFIG.LRU_KEY])) {
      const filtered = result[CACHE_CONFIG.LRU_KEY].filter(id => id !== videoId);
      if (filtered.length !== result[CACHE_CONFIG.LRU_KEY].length) {
        await chrome.storage.local.set({ [CACHE_CONFIG.LRU_KEY]: filtered });
      }
    }

    await clearGenerationStatus(videoId);

  } catch (error) {
    logStorageError('Error clearing cache', error);
  }
}

async function getCacheInfo() {
  try {
    const result = await chrome.storage.local.get(CACHE_CONFIG.LRU_KEY);
    const lruList = Array.isArray(result?.[CACHE_CONFIG.LRU_KEY]) ? result[CACHE_CONFIG.LRU_KEY] : [];

    const keys = [];
    lruList.forEach(id => {
      keys.push(`${CACHE_CONFIG.QUIZ_PREFIX}${id}`);
      keys.push(`${CACHE_CONFIG.TRANSCRIPT_PREFIX}${id}`);
    });

    const cacheEntries = keys.length ? await chrome.storage.local.get(keys) : {};

    return {
      activeVideoId: videoId,
      lru: lruList,
      entries: lruList.map(id => {
        const quizKey = `${CACHE_CONFIG.QUIZ_PREFIX}${id}`;
        const transcriptKey = `${CACHE_CONFIG.TRANSCRIPT_PREFIX}${id}`;
        const quiz = cacheEntries?.[quizKey];
        return {
          videoId: id,
          segments: quiz?.segmentCount || quiz?.segments?.length || 0,
          cachedAt: quiz?.timestamp || null,
          hasTranscript: Boolean(cacheEntries?.[transcriptKey]),
          hasQuizzes: Boolean(quiz)
        };
      })
    };
  } catch (error) {
    logStorageError('Error getting cache info', error);
    return null;
  }
}

window.learntubeCacheInfo = getCacheInfo;
window.learntubeClearCache = clearCachedData;

function updateSeekbarIndicator(segmentIndex) {
  const indicators = document.querySelectorAll('.learntube-quiz-indicator');
  const indicator = indicators[segmentIndex];
  if (!indicator) return;

  const anchorTime = indicator.dataset.anchorTime ? parseInt(indicator.dataset.anchorTime, 10) : null;
  const anchorLabel = Number.isFinite(anchorTime) ? ` @ ${anchorTime}s` : '';

  indicator.style.background = 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
  indicator.title = `Quiz ${segmentIndex + 1}${anchorLabel}`;
}

async function summarizeTranscript(fullText) {
  const sourceText = typeof fullText === 'string' ? fullText.trim() : '';
  if (!sourceText) {
    return null;
  }

  if (typeof Summarizer === 'undefined') {
    console.log('LearnTube: Summarizer API not available, using truncated transcript');
    return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
  }

  const availability = await Summarizer.availability();
  if (availability !== 'available') {
    console.log('LearnTube: Summarizer not available, using truncated transcript');
    return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
  }

  let summarizer = null;
  try {
    summarizer = await Summarizer.create({
      type: 'key-points',
      format: 'plain-text',
      length: 'medium',
      sharedContext: 'This is educational video content.',
      outputLanguage: 'en'
    });

    let chunkSize = TRANSCRIPT_PROCESSING_CONFIG.SUMMARY_CHUNK_CHAR_LIMIT;
    const minChunk = TRANSCRIPT_PROCESSING_CONFIG.SUMMARY_MIN_CHUNK_CHAR_LIMIT;
    let combinedPieces = [];
    let chunkRetryNeeded = true;
    let quotaFallbackUsed = false;

    while (chunkRetryNeeded && chunkSize >= minChunk) {
      const chunks = splitTextIntoChunks(sourceText, chunkSize);
      const summaries = [];
      chunkRetryNeeded = false;

      for (const chunk of chunks) {
        try {
          const result = await summarizer.summarize(chunk);
          if (result && result.trim()) {
            summaries.push(result.trim());
          }
        } catch (error) {
          if (isQuotaExceededError(error)) {
            quotaFallbackUsed = true;
            if (chunkSize > minChunk) {
              chunkSize = Math.max(minChunk, Math.floor(chunkSize * TRANSCRIPT_PROCESSING_CONFIG.CHUNK_REDUCTION_RATIO));
              console.warn('LearnTube: Summary chunk exceeded quota, retrying with smaller chunk size:', chunkSize);
              chunkRetryNeeded = true;
              break;
            }
            console.warn('LearnTube: Summary chunk exceeded quota at minimum chunk size, using truncated transcript');
            return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
          }
          throw error;
        }
      }

      if (!chunkRetryNeeded) {
        combinedPieces = summaries;
      }
    }

    if (!combinedPieces.length) {
      if (quotaFallbackUsed) {
        return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
      }
      console.log('LearnTube: Summarizer returned empty response, using truncated transcript');
      return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
    }

    let combinedSummary = combinedPieces.join('\n\n').trim();
    if (!combinedSummary) {
      return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
    }

    if (combinedSummary.length > TRANSCRIPT_PROCESSING_CONFIG.SUMMARY_COMBINED_CHAR_LIMIT) {
      const limitedInput = trimTextToLimit(combinedSummary, TRANSCRIPT_PROCESSING_CONFIG.SUMMARY_COMBINED_CHAR_LIMIT);
      try {
        const secondPass = await summarizer.summarize(limitedInput);
        if (secondPass && secondPass.trim()) {
          combinedSummary = secondPass.trim();
        } else {
          combinedSummary = limitedInput;
        }
      } catch (error) {
        if (isQuotaExceededError(error)) {
          console.warn('LearnTube: Second-pass summary exceeded quota, using trimmed combined summary');
          combinedSummary = limitedInput;
        } else {
          throw error;
        }
      }
    }

    console.log('LearnTube: Successfully summarized transcript for final quiz');
    return trimTextToLimit(combinedSummary, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
  } catch (error) {
    console.error('LearnTube: Error summarizing transcript:', error);
    return trimTextToLimit(sourceText, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
  } finally {
    if (summarizer && typeof summarizer.destroy === 'function') {
      try {
        summarizer.destroy();
      } catch (destroyError) {
        console.warn('LearnTube: Failed to dispose summarizer session:', destroyError);
      }
    }
  }
}

async function generateQuiz(segment, desiredCount = 2) {
  if (!segment || typeof segment.text !== 'string' || !segment.text.trim()) {
    throw new Error('Segment content unavailable for quiz generation');
  }
  if (typeof LanguageModel === 'undefined') {
    throw new Error('Language Model API unavailable');
  }
  const availability = await LanguageModel.availability();
  if (availability !== 'available') {
    throw new Error(`Language Model not ready (${availability})`);
  }

  let session = null;
  try {
    session = await LanguageModel.create({
      temperature: 0.8,
      topK: 50,
      maxOutputTokens: 1200
    });
    const n = Math.max(1, Math.min(4, desiredCount));
    const promptText = trimTextToLimit(segment.text, TRANSCRIPT_PROCESSING_CONFIG.QUIZ_INPUT_CHAR_LIMIT);
    if (promptText.length < segment.text.length) {
      console.warn('LearnTube: Segment text truncated for quiz prompt due to size limit');
    }
    const header = `You are an expert educator creating engaging multiple-choice questions that check solid understanding without being overly tricky.

Video Content (${Math.round(segment.start || 0)}s - ${Math.round(segment.end || (segment.start || 0) + (segment.duration || 0))}s):
"""
${promptText}
"""

CRITICAL REQUIREMENTS:
1. Focus on core concepts, relationships, or practical implications from the video.
2. Prefer WHY or HOW questions, but include a clear comprehension check when it reinforces the main idea.
3. Avoid pure rote memorization or extreme trick questions; aim for approachable yet thoughtful prompts.
4. Keep language clear and supportive so learners feel guided, not quizzed harshly.

Question Design Rules:
- Write EXACTLY ${n} questions (Q1..Q${n}) with 4 options each (A–D)
- Each question should highlight a DIFFERENT key insight or connection from the content.
- Mix application or implication prompts with scenario-based or direct comprehension checks when helpful.
- Suggested stems: "Why...", "How does...", "What would happen if...", "What is the relationship between...", "Which best explains..."
- Keep reasoning depth moderate; avoid multi-step calculations or obscure edge cases.

Distractor (Wrong Answer) Strategy:
- Make ALL options plausible and connected to the topic.
- Include common misconceptions or partial truths, while keeping the correct answer clear with careful thought.
- Use details from the video in each option so the correct choice is not obvious at a glance.
- Avoid obvious eliminations like "None of the above" or joke answers.
- Keep all options similar in length and style.

Quality Checks:
- Does this require understanding while still feeling approachable?
- Would someone who paid reasonable attention to the segment succeed?
- Are wrong answers believable without being misleading or nitpicky?
- Does it reinforce the main takeaways without overwhelming detail?

Output format (STRICT):`;
    const makeBlock = (i) => `
Q${i}: [Question]
A) [Option]
B) [Option]
C) [Option]
D) [Option]
Correct: [A|B|C|D]`;
    let prompt = header + '\n' + makeBlock(1);
    for (let i = 2; i <= n; i++) {
      prompt += '\n\n' + makeBlock(i);
    }
    const result = await session.prompt(prompt);
    let response;
    if (typeof result === 'string') {
      response = result;
    } else if (result && typeof result === 'object') {
      response = result.response || result.text || result.content || result.output || JSON.stringify(result);
    } else {
      response = String(result);
    }
    const questions = parseQuizResponse(response, n);
    if (!questions || questions.length < n) {
      const count = Array.isArray(questions) ? questions.length : 0;
      throw new Error(`Language model returned ${count} question(s); expected ${n}`);
    }
    return questions;
  } catch (error) {
    throw error;
  } finally {
    if (session && typeof session.destroy === 'function') {
      try {
        session.destroy();
      } catch (destroyError) {
        console.warn('LearnTube: Failed to dispose language model session:', destroyError);
      }
    }
  }
}

function parseQuizResponse(response, desiredCount = 1) {
  if (typeof response !== 'string') {
    response = String(response);
  }
  if (!response || response.trim().length === 0) {
    return [];
  }
  const questions = [];
  try {
    if (response.trim().startsWith('[') || response.trim().startsWith('{')) {
      const jsonResponse = JSON.parse(response);
      if (Array.isArray(jsonResponse)) {
        for (const item of jsonResponse) {
          if (item.question && item.options && Array.isArray(item.options) && item.options.length >= 2) {
            questions.push({
              question: item.question,
              options: item.options,
              correct: item.answer || item.correct || 0
            });
          }
        }
        if (questions.length > 0) return questions;
      }
    }
    const questionBlocks = response.split(/Q\d+:/).filter(block => block.trim());
    for (const block of questionBlocks) {
      const lines = block.trim().split('\n').filter(line => line.trim());
      if (lines.length < 3) continue;
      const question = lines[0].trim();
      const options = [];
      let correct = -1;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^[A-D]\)/i.test(line)) {
          const optionText = line.replace(/^[A-D]\)\s*/, '').trim();
          options.push(optionText);
        } else if (/^Correct:/i.test(line)) {
          const match = line.match(/Correct:\s*([A-D])/i);
          if (match && match[1]) {
            correct = match[1].toUpperCase().charCodeAt(0) - 65;
          }
        }
      }
      const hasValidCorrect = correct >= 0 && correct < options.length;
      if (question && options.length >= 2 && hasValidCorrect) {
        questions.push({ question, options, correct });
      }
    }
    if (desiredCount > 0 && questions.length >= desiredCount) {
      return questions.slice(0, desiredCount);
    }
    return questions;
  } catch (error) {
    console.error('LearnTube: Error parsing quiz response:', error);
    return [];
  }
}

function showQuiz(questions, segmentIndex) {
  if (quizActive) {
    return;
  }
  quizActive = true;
  const video = videoElement || document.querySelector('video');
  if (video && !video.paused) {
    video.pause();
  }

  const isFinalQuiz = segmentIndex >= videoSegments.length;
  const subtitle = isFinalQuiz
    ? `Final Quiz • ${questions.length} Question${questions.length > 1 ? 's' : ''}`
    : `Segment ${segmentIndex + 1} • ${questions.length} Question${questions.length > 1 ? 's' : ''}`;

  const isLight = userSettings.theme === 'light';

  const cardBg = isLight ? '#ffffff' : '#0f0f0f';
  const cardBorder = isLight ? '#e0e0e0' : 'rgba(255, 255, 255, 0.08)';
  const cardColor = isLight ? '#1a1a1a' : '#f1f1f1';
  const headerBorder = isLight ? '#e0e0e0' : 'rgba(255, 255, 255, 0.08)';
  const titleColor = isLight ? '#1a1a1a' : '#f1f1f1';
  const subtitleColor = isLight ? '#666666' : '#aaaaaa';
  const closeColor = isLight ? '#666666' : '#94a3b8';
  const closeHoverBg = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
  const closeHoverColor = isLight ? '#1a1a1a' : '#f8fafc';
  const scrollTrackBg = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
  const questionBorder = isLight ? '#e0e0e0' : 'rgba(255, 255, 255, 0.1)';
  const questionNumBg = isLight ? '#e0e0e0' : '#000000';
  const questionNumColor = isLight ? '#1a1a1a' : 'white';
  const questionBoxBg = isLight ? '#f5f5f5' : '#111111';
  const questionBoxBorder = isLight ? '#e0e0e0' : 'rgba(255, 255, 255, 0.06)';
  const questionBoxColor = isLight ? '#1a1a1a' : '#f8fafc';
  const optionBg = isLight ? '#f5f5f5' : '#111111';
  const optionBorder = isLight ? '#e0e0e0' : 'rgba(255, 255, 255, 0.08)';
  const optionColor = isLight ? '#1a1a1a' : '#f1f1f1';
  const optionHoverBg = isLight ? '#ececec' : '#131313';
  const optionHoverBorder = isLight ? '#d0d0d0' : 'rgba(255, 255, 255, 0.16)';
  const progressBorder = isLight ? '#e0e0e0' : 'rgba(255, 255, 255, 0.1)';
  const progressColor = isLight ? '#666666' : '#94a3b8';
  const boxShadow = isLight ? '0 8px 24px rgba(0,0,0,0.15)' : '0 8px 24px rgba(0,0,0,0.4)';

  createOverlay(`
    <div class="learntube-card">
      <div class="learntube-header">
        <div class="learntube-icon">🧠</div>
        <div class="learntube-title">
          <h2>Quick Quiz</h2>
          <p class="learntube-subtitle">${subtitle}</p>
        </div>
        <button class="learntube-close">×</button>
      </div>
      
      <div class="learntube-questions-container">
        ${questions.map((question, qIndex) => `
          <div class="learntube-question" data-question-index="${qIndex}">
            <div class="question-number">Question ${qIndex + 1} of ${questions.length}</div>
            <div class="question-box">
              <h3>${question.question}</h3>
            </div>
            
            <div class="learntube-options" data-question-index="${qIndex}">
              ${question.options.map((option, index) => `
                <button class="learntube-option" data-index="${index}" data-correct="${question.correct}" data-question-index="${qIndex}">
                  <span class="option-letter" data-letter="${String.fromCharCode(65 + index)}">${String.fromCharCode(65 + index)}</span>
                  ${option}
                </button>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      
      <div class="progress-indicator">
        <div>Answer all questions to continue</div>
      </div>
    </div>
    
    <style>
      .learntube-card {
        background: ${cardBg};
        border: 1px solid ${cardBorder};
        border-radius: 12px;
        padding: 24px;
        max-width: 560px;
        width: 90%;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        color: ${cardColor};
        position: relative;
        z-index: 1000000;
        animation: slideUp 0.3s ease;
        box-shadow: ${boxShadow};
      }
      
      .learntube-header {
        display: flex;
        align-items: center;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid ${headerBorder};
      }
      
      .learntube-icon {
        display: none;
      }
      
      .learntube-title {
        flex: 1;
      }
      
      .learntube-title h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
        color: ${titleColor};
      }
      
      .learntube-subtitle {
        margin: 4px 0 0 0;
        font-size: 13px;
        color: ${subtitleColor};
        font-weight: 400;
      }
      
      .learntube-close {
        background: none;
        border: none;
        color: ${closeColor};
        font-size: 24px;
        cursor: pointer;
        padding: 4px;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        border-radius: 4px;
      }
      
      .learntube-close:hover {
        background: ${closeHoverBg};
        color: ${closeHoverColor};
      }
      
      .learntube-questions-container {
        overflow-y: auto;
        overflow-x: hidden;
        max-height: 50vh;
        padding-right: 8px;
        margin-bottom: 20px;
      }
      
      .learntube-questions-container::-webkit-scrollbar {
        width: 8px;
      }
      
      .learntube-questions-container::-webkit-scrollbar-track {
        background: ${scrollTrackBg};
        border-radius: 4px;
      }
      
      .learntube-questions-container::-webkit-scrollbar-thumb {
        background: rgba(59, 130, 246, 0.3);
        border-radius: 4px;
      }
      
      .learntube-questions-container::-webkit-scrollbar-thumb:hover {
        background: rgba(59, 130, 246, 0.5);
      }
      
      .learntube-question {
        margin-bottom: 32px;
        padding-bottom: 32px;
        border-bottom: 1px solid ${questionBorder};
      }
      
      .learntube-question:last-child {
        margin-bottom: 0;
        padding-bottom: 0;
        border-bottom: none;
      }
      
      .question-number {
        display: inline-block;
        font-size: 11px;
        font-weight: 500;
        color: ${questionNumColor};
        background: ${questionNumBg};
        padding: 4px 12px;
        border-radius: 12px;
        margin-bottom: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .question-box {
        background: ${questionBoxBg};
        border: 1px solid ${questionBoxBorder};
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 16px;
      }
      
      .question-box h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: ${questionBoxColor};
        line-height: 1.6;
      }
      
      .learntube-options {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .learntube-option {
        background: ${optionBg};
        border: 1px solid ${optionBorder};
        border-radius: 10px;
        padding: 14px 16px;
        color: ${optionColor};
        cursor: pointer;
        text-align: left;
        font-size: 15px;
        font-weight: 500;
        transition: all 0.2s ease;
        position: relative;
        overflow: hidden;
        z-index: 1000001;
        pointer-events: auto;
      }
      
      .learntube-option:hover {
        transform: translateY(-1px);
        border-color: ${optionHoverBorder};
        background: ${optionHoverBg};
      }
      
      .learntube-option.selected {
        border: 2px solid #10b981;
        background: rgba(16, 185, 129, 0.08);
      }
      
      .learntube-option.selected-incorrect {
        border: 2px solid #ef4444;
        background: rgba(239, 68, 68, 0.08);
      }
      
      .option-letter {
        display: inline-block;
        width: 28px;
        height: 28px;
        background: ${isLight ? '#e0e0e0' : '#3ea6ff'};
        border: 1px solid ${isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.2)'};
        border-radius: 6px;
        color: ${isLight ? '#1a1a1a' : 'white'};
        font-weight: 600;
        font-size: 13px;
        text-align: center;
        line-height: 28px;
        margin-right: 12px;
        vertical-align: middle;
      }
      

      .progress-indicator {
        margin-top: 24px;
        padding-top: 20px;
        border-top: 1px solid ${progressBorder};
        text-align: center;
      }
      
      .progress-indicator div {
        color: ${progressColor};
        font-size: 13px;
        font-weight: 500;
      }
      
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(30px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    </style>
  `);
  setTimeout(() => {
    const closeBtn = document.querySelector('.learntube-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        removeOverlay();
        quizActive = false;
        const video = videoElement || document.querySelector('video');
        if (video) {
          video.play();
        }
      });
    }
    let answeredQuestions = new Set();
    const totalQuestions = questions.length;
    const optionButtons = document.querySelectorAll('.learntube-option');
    optionButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        const selected = parseInt(e.currentTarget.getAttribute('data-index'));
        const correct = parseInt(e.currentTarget.getAttribute('data-correct'));
        const questionIndex = parseInt(e.currentTarget.getAttribute('data-question-index'));
        const options = document.querySelectorAll(`.learntube-option[data-question-index="${questionIndex}"]`);
        const isCorrect = selected === correct;
        e.currentTarget.classList.add(isCorrect ? 'selected' : 'selected-incorrect');
        options.forEach((option) => {
          option.disabled = true;
          option.style.cursor = 'not-allowed';
        });
        answeredQuestions.add(questionIndex);
        const currentVideoId = extractVideoId();
        const isFinalQuiz = segmentIndex >= videoSegments.length;
        updateProgress(currentVideoId, segmentIndex, isCorrect, isFinalQuiz);
        const feedbackText = document.createElement('div');
        feedbackText.style.cssText = `
          margin-top: 12px;
          padding: 8px 12px;
          border-radius: 6px;
          text-align: left;
          font-weight: 500;
          font-size: 13px;
          background: ${isCorrect ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'};
          border: 1px solid ${isCorrect ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'};
          color: ${isCorrect ? '#10b981' : '#ef4444'};
        `;
        if (isCorrect) {
          feedbackText.innerHTML = '✅ Correct, Well done!';
        } else {
          feedbackText.innerHTML = '❌ Incorrect. Try again!';
        }
        const optionsContainer = document.querySelector(`.learntube-options[data-question-index="${questionIndex}"]`);
        optionsContainer.parentNode.insertBefore(feedbackText, optionsContainer.nextSibling);
        if (!isCorrect) {
          const retryButton = document.createElement('button');
          retryButton.innerHTML = 'Try Again';
          const retryBg = (userSettings.theme === 'light') ? '#e0e0e0' : '#1e293b';
          const retryBorder = (userSettings.theme === 'light') ? '#c0c0c0' : 'rgba(255, 255, 255, 0.1)';
          const retryColor = (userSettings.theme === 'light') ? '#1a1a1a' : '#f8fafc';
          const retryHoverBg = (userSettings.theme === 'light') ? '#d0d0d0' : '#334155';
          const retryHoverBorder = (userSettings.theme === 'light') ? '#b0b0b0' : 'rgba(255, 255, 255, 0.2)';

          retryButton.style.cssText = `
            margin-top: 12px;
            padding: 10px 18px;
            background: ${retryBg};
            border: 1px solid ${retryBorder};
            border-radius: 8px;
            color: ${retryColor};
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s ease;
            width: 100%;
          `;

          retryButton.onmouseover = () => {
            retryButton.style.background = retryHoverBg;
            retryButton.style.borderColor = retryHoverBorder;
          };
          retryButton.onmouseout = () => {
            retryButton.style.background = retryBg;
            retryButton.style.borderColor = retryBorder;
          };

          retryButton.onclick = () => {
            feedbackText.remove();
            retryButton.remove();
            options.forEach((option) => {
              option.disabled = false;
              option.style.cursor = 'pointer';
              option.classList.remove('selected', 'selected-incorrect');
            });
            answeredQuestions.delete(questionIndex);
          };

          optionsContainer.parentNode.insertBefore(retryButton, feedbackText.nextSibling);
        }
      });
    });
  }, 50);
}

async function showFinalQuiz(segments) {
  if (!isNonEmptyArray(segments)) {
    finalQuizShown = false;
    return false;
  }

  if (quizActive) {
    removeOverlay();
    quizActive = false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const waitForCurrentGeneration = async () => {
    const timeoutMs = 12000;
    const start = Date.now();
    while (finalQuizGenerating && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };

  await waitForCurrentGeneration();
  await ensureFinalQuizReady(segments, { allowGeneration: false, cacheAfter: false });

  if (!hasFinalQuizData()) {
    console.warn('LearnTube: Final quiz not ready when requested');
    const currentFinalStatus = (generationStatus?.final?.status || '').toLowerCase();
    if (currentFinalStatus !== 'error') {
      await markFinalStatus('processing', 0, 'Final quiz still generating');
    }
    finalQuizShown = false;
    return false;
  }

  if ((generationStatus?.final?.status || '').toLowerCase() !== 'completed') {
    try {
      await markFinalStatus('completed', finalQuizQuestions.length, '');
    } catch (error) {
      logStorageError('Error updating final quiz status after cache load', error);
    }
  }

  showQuiz(finalQuizQuestions, segments.length);
  return true;
}

function createOverlay(content) {
  const existingOverlay = document.getElementById('learntube-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }
  const overlay = document.createElement('div');
  overlay.id = 'learntube-overlay';
  overlay.setAttribute('data-theme', userSettings.theme || 'dark');
  overlay.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100% !important;
    height: 100% !important;
    background: rgba(0, 0, 0, 0.7) !important;
    backdrop-filter: blur(10px) !important;
    z-index: 999999 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
  `;
  overlay.innerHTML = content;
  document.body.appendChild(overlay);
  return overlay;
}

function removeOverlay() {
  const overlay = document.getElementById('learntube-overlay');
  if (overlay) {
    overlay.remove();
  }
}

async function monitorVideo() {
  if (!videoElement) return;

  if (typeof monitorCleanup === 'function') {
    monitorCleanup();
    monitorCleanup = null;
  }

  if (monitorAttached) return;

  monitorAttached = true;

  let transcriptFetchPromise = null;
  let lastCheckTime = 0;

  const startTranscriptIfReady = (currentTime, videoDuration) => {
    if (transcriptFetchPromise || transcriptProcessStarted) {
      return false;
    }
    if (!videoDuration || Number.isNaN(videoDuration) || !Number.isFinite(videoDuration)) {
      return false;
    }
    const startThreshold = videoDuration * 0.03;
    if (currentTime >= startThreshold) {
      transcriptFetchPromise = startTranscriptProcess().then(success => {
        if (!success) {
          transcriptFetchPromise = null;
        }
        return success;
      }).catch(error => {
        console.error('LearnTube: Transcript process error:', error);
        transcriptFetchPromise = null;
      });
      return true;
    }
    return false;
  };

  const checkProgress = () => {
    if (!videoElement) {
      return;
    }

    const currentTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
    const videoDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;

    if (quizActive) {
      lastCheckTime = currentTime;
      return;
    }

    if (!userSettings.enabled) {
      return;
    }

    if (!userSettings.autoQuiz && !userSettings.finalQuizEnabled) {
      return;
    }

    if (startTranscriptIfReady(currentTime, videoDuration)) {
      lastCheckTime = currentTime;
      return;
    }

    if (!Array.isArray(videoSegments) || videoSegments.length === 0) {
      lastCheckTime = currentTime;
      return;
    }

    if (!userSettings.autoQuiz) {
      lastCheckTime = currentTime;
      return;
    }

    if (!videoDuration) {
      lastCheckTime = currentTime;
      return;
    }

    const skipThreshold = videoDuration * 0.03;
    if (currentTime < skipThreshold) {
      lastCheckTime = currentTime;
      return;
    }

    for (let i = 0; i < videoSegments.length; i++) {
      const segment = videoSegments[i];
      if (!segment || typeof segment.end !== 'number') continue;

      const isAtSegmentEnd = currentTime >= segment.end && currentTime < (segment.end + 3);
      const timeDiff = Math.abs(currentTime - lastCheckTime);
      const isBigSeek = timeDiff > 3 && lastCheckTime > 0;

      if (isBigSeek && currentTime < lastCheckTime) {
        for (let j = 0; j < videoSegments.length; j++) {
          if (videoSegments[j].start > currentTime) {
            shownSegmentsSet.delete(j);
          }
        }
      }

      if (isAtSegmentEnd && !shownSegmentsSet.has(i)) {
        const displayed = autoShowSegmentQuiz(i);
        if (displayed) {
          console.log(`LearnTube: Auto-triggered quiz for segment ${i + 1} at ${currentTime.toFixed(1)}s`);
          break;
        }

        if (!pendingSegmentTriggers.has(i)) {
          console.log(`LearnTube: Quiz for segment ${i + 1} not ready; generating now`);
          pendingSegmentTriggers.add(i);
          if (segment.status !== 'processing') {
            handleSegmentGeneration(segment, i).catch(error => {
              console.error(`LearnTube: On-demand quiz generation failed for segment ${i + 1}:`, error);
            });
          }
        }

        break;
      }
    }

    lastCheckTime = currentTime;
  };

  const triggerFinalIfDue = () => {
    if (!videoElement) return;
    if (!userSettings.enabled) return;
    if (!userSettings.finalQuizEnabled) return;
    if (!userSettings.autoQuiz) return;
    if (finalQuizShown) return;
    if (!Array.isArray(videoSegments) || videoSegments.length === 0) return;
    const duration = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;
    if (!duration) return;
    const triggerTime = duration * (CONFIG.FINAL_QUIZ_TRIGGER_PERCENTAGE || 0.92);
    if (videoElement.currentTime >= triggerTime) {
      finalQuizShown = true;
      setTimeout(async () => {
        try {
          const shown = await showFinalQuiz(videoSegments);
          if (!shown) {
            finalQuizShown = false;
          }
        } catch (error) {
          console.error('LearnTube: Error showing final quiz:', error);
          finalQuizShown = false;
        }
      }, 500);
    }
  };

  const endedHandler = async () => {
    if (!userSettings.enabled) return;
    if (!userSettings.finalQuizEnabled) return;

    if (!finalQuizShown && videoSegments.length > 0) {
      if (userSettings.autoQuiz) {
        finalQuizShown = true;
        setTimeout(async () => {
          try {
            const shown = await showFinalQuiz(videoSegments);
            if (!shown) {
              finalQuizShown = false;
            }
          } catch (error) {
            console.error('LearnTube: Error showing final quiz:', error);
            finalQuizShown = false;
          }
        }, 1000);
      }
    }
  };

  videoElement.addEventListener('timeupdate', checkProgress);
  videoElement.addEventListener('timeupdate', triggerFinalIfDue);
  videoElement.addEventListener('ended', endedHandler);

  monitorCleanup = () => {
    videoElement.removeEventListener('timeupdate', checkProgress);
    videoElement.removeEventListener('timeupdate', triggerFinalIfDue);
    videoElement.removeEventListener('ended', endedHandler);
    monitorAttached = false;
  };
}

// Start the transcript fetching and quiz generation process
async function startTranscriptProcess() {
  if (transcriptProcessStarted) {
    console.log('LearnTube: Transcript process already started, skipping duplicate call');
    return false;
  }
  transcriptProcessStarted = true;
  pendingSegmentTriggers.clear();

  let success = false;

  try {
    const currentVideoId = extractVideoId();
    if (!currentVideoId) {
      return false;
    }

    videoId = currentVideoId;

    await loadUserSettings();

    const cachedData = await getCachedQuizzes(currentVideoId);
    if (cachedData?.segments?.length) {
      console.log('LearnTube: Cache hit - loaded', cachedData.segments.length, 'segments');

      videoSegments = cachedData.segments;
      finalQuizQuestions = cachedData.finalQuiz || null;

      if (finalQuizQuestions?.length) {
        console.log(`LearnTube: Final quiz also loaded from cache (${finalQuizQuestions.length} questions)`);
      } else {
        console.log('LearnTube: Final quiz not found in cache');
      }

      videoSegments.forEach((segment, index) => {
        const hasQuestions = Array.isArray(segment?.questions) && segment.questions.length > 0;
        segment.status = hasQuestions ? 'completed' : 'pending';
        segment.errorMessage = '';
        if (hasQuestions) {
          console.log(`LearnTube: Segment ${index + 1} loaded with ${segment.questions.length} cached question(s)`);
        }
      });

      await clearGenerationStatus(currentVideoId);
      generationStatus = createInitialGenerationStatus(videoSegments.length);

      generationStatus.videoId = currentVideoId;
      generationStatus.videoTitle = getCurrentVideoTitle();
      generationStatus.segments = videoSegments.map((segment, index) => {
        const hasQuestions = Array.isArray(segment?.questions) && segment.questions.length > 0;
        const status = hasQuestions ? 'completed' : 'pending';
        const questionCount = hasQuestions ? segment.questions.length : 0;
        return {
          index,
          status,
          questionCount,
          target: userSettings.questionCount || 1,
          message: ''
        };
      });

      if (!generationStatus.final) {
        generationStatus.final = {
          status: userSettings.finalQuizEnabled
            ? (finalQuizQuestions?.length ? 'completed' : 'pending')
            : 'skipped',
          questionCount: finalQuizQuestions?.length || 0,
          target: CONFIG.FINAL_QUIZ_QUESTIONS_MIN,
          message: ''
        };
      } else if (!userSettings.finalQuizEnabled) {
        generationStatus.final.status = 'skipped';
        generationStatus.final.questionCount = 0;
        generationStatus.final.message = '';
      } else if (finalQuizQuestions?.length) {
        generationStatus.final.status = 'completed';
        generationStatus.final.questionCount = finalQuizQuestions.length;
        generationStatus.final.message = '';
      } else {
        generationStatus.final.status = 'pending';
        generationStatus.final.questionCount = 0;
        generationStatus.final.message = '';
      }

      await persistGenerationStatus();

      const missingIndices = [];
      let hasAnyQuestions = false;

      videoSegments.forEach((segment, index) => {
        if (!segment.questions?.length) {
          missingIndices.push(index);
        } else {
          hasAnyQuestions = true;
        }
      });

      let finalQuizPromise = null;
      if (userSettings.finalQuizEnabled && (!finalQuizQuestions || finalQuizQuestions.length === 0)) {
        finalQuizPromise = ensureFinalQuizReady(videoSegments, { cacheAfter: false }).catch(error => {
          console.error('LearnTube: Final quiz generation failed after cache load:', error);
          return null;
        });
      }

      if (missingIndices.length) {
        console.log(`LearnTube: ${missingIndices.length} segments missing questions, generating in parallel`);
        const batchSize = 3;
        for (let i = 0; i < missingIndices.length; i += batchSize) {
          const batch = missingIndices.slice(i, i + batchSize).map(index => handleSegmentGeneration(videoSegments[index], index));
          await Promise.all(batch);
          if (i + batchSize < missingIndices.length) {
            await new Promise(r => setTimeout(r, 200));
          }
        }
        console.log('LearnTube: All missing quizzes generated');
      }

      if (finalQuizPromise) {
        await finalQuizPromise;
      }

      await persistGenerationStatus();
      await cacheAllQuizzes(currentVideoId, videoSegments);

      indicatorsAllowed = true;
      addQuizIndicatorsToSeekbar();

      if (!hasAnyQuestions && videoSegments.length > 0) {
        updateSeekbarIndicator(0);
      }

      setTimeout(() => indicatorsAllowed && addQuizIndicatorsToSeekbar(), 1500);
      success = true;
      return true;
    }

    console.log('LearnTube: Cache miss - fetching transcript');

    let transcript = await getCachedTranscript(currentVideoId);
    if (!transcript) {
      transcript = await getTranscript();
      if (!transcript?.length) {
        console.warn('LearnTube: Transcript not available yet, will retry');
        return false;
      }

      await cacheTranscript(currentVideoId, transcript);
    }

    console.log('LearnTube: Segmenting transcript and pre-generating quizzes');
    videoSegments = segmentTranscript(transcript);
    if (!Array.isArray(videoSegments) || videoSegments.length === 0) {
      console.warn('LearnTube: Transcript segmentation produced no segments');
      return false;
    }

    await pregenerateAllQuizzes();

    indicatorsAllowed = true;
    addQuizIndicatorsToSeekbar();

    success = true;
    return true;
  } catch (error) {
    console.error('LearnTube: Transcript process failed:', error);
    return false;
  } finally {
    if (!success) {
      transcriptProcessStarted = false;
    }
  }
}

// Clear seekbar indicators
function clearSeekbarIndicators() {
  const existingIndicators = document.querySelectorAll('.learntube-quiz-indicator');
  existingIndicators.forEach(indicator => indicator.remove());
  indicatorsAdded = false;
  if (seekbarObserver) {
    seekbarObserver.disconnect();
    seekbarObserver = null;
  }
}

// Add visual indicators on the seekbar to show when quizzes will appear
function addQuizIndicatorsToSeekbar() {
  if (!indicatorsAllowed) {
    return;
  }
  if (!videoSegments || videoSegments.length === 0) {
    return;
  }
  if (indicatorsAdded) {
    return;
  }

  // Find the seekbar container with more options
  let seekbarContainer = null;
  for (const selector of SEEK_BAR_SELECTORS) {
    const element = document.querySelector(selector);
    if (element) {
      seekbarContainer = element;
      break;
    }
  }

  if (!seekbarContainer) {
    setTimeout(() => addQuizIndicatorsToSeekbar(), 2000);
    return;
  }

  // Check video element
  if (!videoElement) {
    videoElement = document.querySelector('video');
    if (!videoElement) {
      setTimeout(() => addQuizIndicatorsToSeekbar(), 1000);
      return;
    }
  }

  // Check video duration
  if (!videoElement.duration || isNaN(videoElement.duration) || !Number.isFinite(videoElement.duration) || videoElement.duration === 0) {
    setTimeout(() => addQuizIndicatorsToSeekbar(), 1000);
    return;
  }

  // Ensure container can anchor absolutely positioned children
  try {
    const containerStyle = window.getComputedStyle(seekbarContainer);
    if (containerStyle.position === 'static') {
      seekbarContainer.style.position = 'relative';
    }
  } catch (e) { }

  // Remove existing indicators
  clearSeekbarIndicators();

  // Add indicators for each quiz segment (anchor at segment end)
  let addedCount = 0;
  videoSegments.forEach((segment, index) => {
    const duration = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;
    const anchorTime = (() => {
      const end = typeof segment.end === 'number' ? segment.end : undefined;
      const start = typeof segment.start === 'number' ? segment.start : 0;
      let t = typeof end === 'number' ? end : start;
      if (!duration || Number.isNaN(duration) || duration <= 0) return t;
      // Clamp inside duration to avoid off-by-one/rounding placing beyond the bar
      t = Math.max(0, Math.min(t, Math.max(0, duration - 0.25)));
      return t;
    })();
    if (Number.isFinite(anchorTime)) {
      const safeDuration = duration || 1;
      const positionPercent = ((anchorTime / safeDuration) * 100).toFixed(4);

      // Create indicator element
      const indicator = document.createElement('div');
      indicator.className = 'learntube-quiz-indicator';
      indicator.setAttribute('data-segment-index', index);
      indicator.style.cssText = `
        position: absolute !important;
        top: 50% !important;
        left: ${positionPercent}% !important;
        width: 16px !important;
        height: 16px !important;
        background: linear-gradient(135deg, #3b82f6, #1d4ed8) !important;
        border: 2px solid white !important;
        border-radius: 50% !important;
        transform: translate(-50%, -50%) !important;
        z-index: 999999 !important;
        cursor: pointer !important;
        transition: all 0.3s ease !important;
        pointer-events: auto !important;
      `;
      indicator.dataset.anchorTime = `${Math.round(anchorTime)}`;

      // Add hover effect
      indicator.addEventListener('mouseenter', () => {
        indicator.style.transform = 'translate(-50%, -50%) scale(1.2)';
      });

      indicator.addEventListener('mouseleave', () => {
        indicator.style.transform = 'translate(-50%, -50%) scale(1)';
      });

      // Add click handler to jump near the segment end and trigger quiz
      indicator.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();

        if (!userSettings.enabled) {
          console.log('LearnTube: Extension is disabled, quiz not triggered');
          return;
        }

        if (videoElement && segment.questions && segment.questions.length > 0 && !quizActive) {
          // Pause video immediately
          videoElement.pause();

          // Set time to segment end (minus a small epsilon to be within range)
          const epsilon = 0.1;
          const t = Math.max(0, (typeof segment.end === 'number' ? segment.end : segment.start) - epsilon);
          videoElement.currentTime = t;

          // Mark this segment as shown to prevent immediate re-trigger via timeupdate
          shownSegmentsSet.add(index);

          // Trigger quiz directly
          showQuiz(segment.questions, index);
        }
      });

      // Add to seekbar
      seekbarContainer.appendChild(indicator);
      updateSeekbarIndicator(index);
      addedCount++;
    }
  });

  console.log(`LearnTube: Successfully added ${addedCount} indicators`);

  // Start monitoring for indicator updates
  startIndicatorMonitoring();

  // If nothing was added (DOM not ready yet), retry shortly
  if (addedCount === 0) {
    setTimeout(() => {
      if (indicatorsAllowed) addQuizIndicatorsToSeekbar();
    }, 1500);
    return;
  }

  // Mark as successfully added
  indicatorsAdded = true;

  // Add final quiz indicator at 92% of video duration
  try {
    const duration = videoElement.duration || 0;
    const triggerPercentage = CONFIG.FINAL_QUIZ_TRIGGER_PERCENTAGE || 0.92;
    if (
      duration &&
      Number.isFinite(duration) &&
      userSettings.finalQuizEnabled &&
      hasFinalQuizData()
    ) {
      const positionPercent = (triggerPercentage * 100).toFixed(4);
      const finalIndicator = document.createElement('div');
      finalIndicator.className = 'learntube-quiz-indicator learntube-final-indicator';
      finalIndicator.style.cssText = `
        position: absolute !important;
        top: 50% !important;
        left: ${positionPercent}% !important;
        width: 18px !important;
        height: 18px !important;
        background: linear-gradient(135deg, #22c55e, #16a34a) !important;
        border: 2px solid white !important;
        border-radius: 4px !important;
        transform: translate(-50%, -50%) rotate(45deg) !important;
        z-index: 999999 !important;
        cursor: pointer !important;
        transition: all 0.3s ease !important;
        pointer-events: auto !important;
      `;
      finalIndicator.title = `Final Quiz`;
      finalIndicator.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!quizActive) {
          const previousState = finalQuizShown;
          finalQuizShown = true;
          try {
            const shown = await showFinalQuiz(videoSegments);
            if (!shown) {
              finalQuizShown = previousState;
            }
          } catch (error) {
            console.error('LearnTube: Error opening final quiz from indicator:', error);
            finalQuizShown = previousState;
          }
        }
      });
      seekbarContainer.appendChild(finalIndicator);
    }
  } catch { }

  // Observe seekbar DOM changes; re-add indicators if they are removed by UI re-renders
  try {
    if (seekbarObserver) {
      seekbarObserver.disconnect();
      seekbarObserver = null;
    }
    if (seekbarContainer) {
      seekbarObserver = new MutationObserver(() => {
        const present = document.querySelectorAll('.learntube-quiz-indicator').length;
        if (indicatorsAllowed && present === 0 && videoSegments && videoSegments.length > 0) {
          indicatorsAdded = false;
          addQuizIndicatorsToSeekbar();
        }
      });
      seekbarObserver.observe(seekbarContainer, { childList: true, subtree: true });
    }
  } catch (e) {
    // ignore observer setup errors
  }
}

// Add or update a single indicator for a given segment index
function addIndicatorForSegment(index) {
  if (!indicatorsAllowed) return;
  if (!videoElement) return;
  const segment = videoSegments[index];
  if (!segment || segment.end === undefined) return;

  // Ensure seekbar container exists
  const seekbarContainer = document.querySelector('.ytp-progress-bar-container') ||
    document.querySelector('.ytp-progress-bar') ||
    document.querySelector('#progress-bar') ||
    document.querySelector('.ytp-chapter-container') ||
    document.querySelector('.ytp-chapters-container') ||
    document.querySelector('.ytp-progress-list') ||
    document.querySelector('.html5-progress-bar-container') ||
    document.querySelector('.html5-progress-bar');
  if (!seekbarContainer) return;

  // Remove any existing indicator at this index
  const existing = document.querySelector(`.learntube-quiz-indicator[data-segment-index="${index}"]`);
  if (existing) existing.remove();

  const duration = videoElement.duration || 0;
  const anchorTime = (() => {
    const end = typeof segment.end === 'number' ? segment.end : undefined;
    const start = typeof segment.start === 'number' ? segment.start : 0;
    let t = typeof end === 'number' ? end : start;
    if (!duration || isNaN(duration) || duration <= 0) return t;
    t = Math.max(0, Math.min(t, Math.max(0, duration - 0.25)));
    return t;
  })();
  const positionPercent = ((anchorTime / (videoElement.duration || 1)) * 100).toFixed(4);
  const indicator = document.createElement('div');
  indicator.className = 'learntube-quiz-indicator';
  indicator.setAttribute('data-segment-index', index);
  indicator.style.cssText = `
    position: absolute !important;
    top: 50% !important;
    left: ${positionPercent}% !important;
    width: 14px !important;
    height: 14px !important;
    background: linear-gradient(135deg, #3b82f6, #1d4ed8) !important;
    border: 2px solid white !important;
    border-radius: 50% !important;
    transform: translate(-50%, -50%) !important;
    z-index: 999999 !important;
    cursor: pointer !important;
    transition: all 0.3s ease !important;
    pointer-events: auto !important;
  `;
  indicator.dataset.anchorTime = `${Math.round(anchorTime)}`;

  indicator.addEventListener('mouseenter', () => {
    indicator.style.transform = 'translate(-50%, -50%) scale(1.2)';
  });
  indicator.addEventListener('mouseleave', () => {
    indicator.style.transform = 'translate(-50%, -50%) scale(1)';
  });
  indicator.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (!userSettings.enabled) {
      console.log('LearnTube: Extension is disabled, quiz not triggered');
      return;
    }

    if (videoElement && segment.questions && segment.questions.length > 0 && !quizActive) {
      videoElement.pause();
      const epsilon = 0.1;
      const t = Math.max(0, (typeof segment.end === 'number' ? segment.end : segment.start) - epsilon);
      videoElement.currentTime = t;
      shownSegmentsSet.add(index);
      showQuiz(segment.questions, index);
    }
  });
  seekbarContainer.appendChild(indicator);
  updateSeekbarIndicator(index);
}

// Monitor video progress to update indicator states
function startIndicatorMonitoring() {
  const indicatorVideoElement = videoElement;
  if (!indicatorVideoElement) return;

  const updateIndicators = () => {
    const indicators = document.querySelectorAll('.learntube-quiz-indicator');

    indicators.forEach((indicator, index) => {
      if (indicator.classList.contains('learntube-final-indicator')) {
        if (!indicator.title) {
          indicator.title = 'Final Quiz';
        }
        return;
      }
      const anchorTime = indicator.dataset.anchorTime ? parseInt(indicator.dataset.anchorTime, 10) : null;
      const anchorLabel = Number.isFinite(anchorTime) ? ` @ ${anchorTime}s` : '';
      const segmentIndex = Number.parseInt(indicator.getAttribute('data-segment-index'), 10);
      const quizNumber = Number.isFinite(segmentIndex) ? segmentIndex + 1 : index + 1;
      indicator.style.background = 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
      indicator.title = `Quiz ${quizNumber}${anchorLabel}`;
    });
  };

  // Update indicators every 10 seconds
  updateIndicators();
  const indicatorInterval = setInterval(updateIndicators, 10000);

  // Clean up when video changes
  const cleanup = () => {
    clearInterval(indicatorInterval);
    if (indicatorVideoElement) {
      indicatorVideoElement.removeEventListener('loadstart', cleanup);
      indicatorVideoElement.removeEventListener('ended', cleanup);
    }
  };

  // Clean up on video change
  indicatorVideoElement.addEventListener('loadstart', cleanup);
  indicatorVideoElement.addEventListener('ended', cleanup);
}

async function init() {
  // Load settings first
  await loadUserSettings();
  await pingDailyAnalytics();

  // Check if extension is enabled
  if (!userSettings.enabled) {
    console.log('LearnTube: Extension is disabled, skipping initialization');
    return;
  }

  videoId = extractVideoId();
  if (!videoId) {
    return;
  }

  if (videoId !== lastClearedVideoId) {
    try {
      await clearGenerationStatus(videoId);
    } catch (error) {
      logStorageError('Error clearing generation status during init', error);
    }
  }
  lastClearedVideoId = null;

  videoElement = document.querySelector('video');
  if (!videoElement) {
    return;
  }

  videoElement.addEventListener('loadstart', () => {
    if (typeof monitorCleanup === 'function') {
      monitorCleanup();
      monitorCleanup = null;
    } else {
      monitorAttached = false;
    }
    setTimeout(monitorVideo, 0);
  });

  monitorVideo();
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'clearCache') {
    (async () => {
      try {
        const currentVideoId = extractVideoId();
        if (!currentVideoId) {
          sendResponse({ success: false, message: 'No video ID found' });
          return;
        }

        await clearCachedData(currentVideoId);
        sendResponse({ success: true, message: 'Cache cleared for this video' });
      } catch (error) {
        console.error('LearnTube: Error clearing cache:', error);
        sendResponse({ success: false, message: 'Failed to clear cache' });
      }
    })();
    return true;
  }

  if (message.action === 'getVideoProgress') {
    (async () => {
      try {
        const currentVideoId = extractVideoId();
        if (!currentVideoId) {
          sendResponse({ success: false, message: 'No video ID found' });
          return;
        }

        // Get video title
        const videoTitle = document.querySelector('h1.title yt-formatted-string')?.textContent ||
          document.querySelector('h1.title')?.textContent ||
          'Unknown Video';

        // Get progress data from storage
        const result = await chrome.storage.local.get('learntube_progress');
        const progress = result.learntube_progress || {};
        const videoProgress = progress[currentVideoId];

        if (!videoProgress || !videoProgress.segments) {
          sendResponse({ success: false, message: 'No progress data found' });
          return;
        }

        // Calculate stats for current video
        let totalQuestions = 0;
        let totalCorrect = 0;

        videoProgress.segments.forEach(segment => {
          if (segment && segment.total) {
            totalQuestions += segment.total;
            totalCorrect += segment.score || 0;
          }
        });

        const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;

        sendResponse({
          success: true,
          data: {
            videoTitle: videoTitle.trim(),
            totalQuestions,
            totalCorrect,
            accuracy
          }
        });

      } catch (error) {
        if (isContextInvalidated(error)) {
          console.log('LearnTube: Extension reloaded, cannot get video progress');
          sendResponse({ success: false, message: 'Extension reloaded' });
        } else {
          console.error('LearnTube: Error getting video progress:', error);
          sendResponse({ success: false, message: 'Error getting progress data' });
        }
      }
    })();

    return true;
  }

  if (message.action === 'checkModelStatus') {
    checkModelStatus()
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        console.error('LearnTube: Failed to check model status:', error);
        sendResponse({
          success: false,
          languageModel: { status: 'not-ready', message: 'Check failed', canDownload: false },
          summarizer: { status: 'not-ready', message: 'Check failed', canDownload: false }
        });
      });
    return true;
  }

  if (message.action === 'hasCache') {
    (async () => {
      try {
        const currentVideoId = extractVideoId();
        if (!currentVideoId) {
          sendResponse({ success: false, hasCache: false });
          return;
        }
        const cachedData = await getCachedQuizzes(currentVideoId);
        const hasCache = Boolean(cachedData?.segments?.length);
        sendResponse({ success: true, hasCache });
      } catch (error) {
        sendResponse({ success: false, hasCache: false });
      }
    })();
    return true;
  }

  if (message.action === 'downloadModel') {
    downloadModel(message.modelType)
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        console.error('LearnTube: Failed to download model:', error);
        sendResponse({ success: false, message: 'Download failed' });
      });
    return true;
  }

  if (message.action === 'updateSettings') {
    loadUserSettings().then(async () => {
      await pingDailyAnalytics();
      if (!userSettings.enabled) {
        console.log('LearnTube: Extension disabled, cleaning up');
        removeOverlay();
        clearSeekbarIndicators();
        quizActive = false;
        transcriptProcessStarted = false;
        pendingSegmentTriggers.clear();
        modelsInitialized = false;
        modelsInitializing = false;
        if (typeof monitorCleanup === 'function') {
          monitorCleanup();
          monitorCleanup = null;
        }
        // Clear current video's generation status when disabled
        if (videoId && generationStatus) {
          generationStatus = null;
          await persistGenerationStatus();
        }
      } else {
        const currentVideoId = extractVideoId();
        if (currentVideoId && !videoElement) {
          console.log('LearnTube: Extension enabled, reinitializing');
          await init();
        } else if (videoElement) {
          monitorVideo();
        }
      }
      sendResponse({ success: true });
    }).catch(error => {
      console.error('LearnTube: Error updating settings:', error);
      sendResponse({ success: false, message: 'Failed to update settings' });
    });
    return true;
  }

  return true;
});

// Check model status function
async function checkModelStatus() {
  const result = {
    languageModel: { status: 'not-ready', message: 'Not available', canDownload: false },
    summarizer: { status: 'not-ready', message: 'Not available', canDownload: false }
  };

  const checkAvailability = async (Model) => {
    if (typeof Model === 'undefined') return { status: 'not-ready', message: 'Not available', canDownload: false };

    try {
      const availability = await Model.availability();
      switch (availability) {
        case 'available':
          return { status: 'ready', message: 'Ready', canDownload: false };
        case 'downloading':
          return { status: 'checking', message: 'Downloading...', canDownload: false };
        case 'downloadable':
          return { status: 'not-ready', message: 'Download required', canDownload: true };
        case 'unavailable':
        default:
          return { status: 'not-ready', message: 'Not available', canDownload: false };
      }
    } catch (error) {
      return { status: 'not-ready', message: 'Error: ' + error.message, canDownload: false };
    }
  };

  try {
    result.languageModel = await checkAvailability(LanguageModel);
    result.summarizer = await checkAvailability(Summarizer);
  } catch (error) {
    console.error('LearnTube: Error checking model status:', error);
    result.languageModel = { status: 'not-ready', message: 'Check failed', canDownload: false };
    result.summarizer = { status: 'not-ready', message: 'Check failed', canDownload: false };
  }

  return result;
}


const MODEL_DOWNLOADERS = {
  languageModel: {
    label: 'Language Model',
    isAvailable: () => typeof LanguageModel !== 'undefined',
    unavailableMessage: 'LanguageModel API not available',
    create: () => LanguageModel.create({
      temperature: 0.7,
      topK: 40,
      monitor: attachDownloadMonitor('languageModel', 'Language Model')
    })
  },
  summarizer: {
    label: 'Summarizer',
    isAvailable: () => typeof Summarizer !== 'undefined',
    unavailableMessage: 'Summarizer API not available',
    create: () => Summarizer.create({
      type: 'key-points',
      format: 'plain-text',
      length: 'medium',
      sharedContext: 'This is educational video content.',
      outputLanguage: 'en',
      monitor: attachDownloadMonitor('summarizer', 'Summarizer')
    })
  }
};

function attachDownloadMonitor(modelType, label) {
  return (monitor) => {
    if (!monitor || typeof monitor.addEventListener !== 'function') {
      return;
    }
    monitor.addEventListener('downloadprogress', (event) => {
      const percentage = Math.round((event?.loaded || 0) * 100);
      console.log(`LearnTube: ${label} downloaded ${percentage}%`);
      safeRuntimeSendMessage({
        type: 'MODEL_DOWNLOAD_PROGRESS',
        modelType,
        progress: percentage
      });
    });
  };
}

// Download model function
async function downloadModel(modelType) {
  try {
    const config = MODEL_DOWNLOADERS[modelType];
    if (!config) {
      return { success: false, message: 'Unknown model type' };
    }

    if (!config.isAvailable()) {
      return { success: false, message: config.unavailableMessage };
    }

    await config.create();
    console.log(`LearnTube: ${config.label} download initiated`);
    return { success: true, message: 'Download initiated' };
  } catch (error) {
    console.error('LearnTube: Error downloading model:', error);
    return { success: false, message: 'Download failed: ' + error.message };
  }
}

// Auto-initialize models on page load
async function autoInitializeModels() {
  if (modelsInitialized || modelsInitializing) {
    return;
  }
  modelsInitializing = true;
  try {
    // Check LanguageModel
    if (typeof LanguageModel !== 'undefined') {
      const lmAvailability = await LanguageModel.availability();
      console.log('LearnTube: LanguageModel availability:', lmAvailability);

      if (lmAvailability === 'downloadable' || lmAvailability === 'available') {
        modelsInitialized = false;
        return;
      }
    }

    // Check Summarizer
    if (typeof Summarizer !== 'undefined') {
      const smAvailability = await Summarizer.availability();
      console.log('LearnTube: Summarizer availability:', smAvailability);

      if (smAvailability === 'downloadable' || smAvailability === 'available') {
        modelsInitialized = false;
        return;
      }
    }

    modelsInitialized = true;
  } catch (error) {
    console.log('LearnTube: Error during model auto-initialization:', error.message);
    modelsInitialized = false;
  } finally {
    modelsInitializing = false;
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', async () => {
    await init();
    autoInitializeModels();
  });
} else {
  (async () => {
    await init();
    autoInitializeModels();
  })();
}

// Re-initialize on navigation
let currentUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== currentUrl) {
    const newVideoId = extractVideoId();
    if (newVideoId && newVideoId !== videoId) {
      currentUrl = window.location.href;
      // Clear persisted status so the popup rebuilds stats for the new video
      const statusResetPromise = (async () => {
        try {
          await clearGenerationStatus(newVideoId);
          lastClearedVideoId = newVideoId;
        } catch (error) {
          logStorageError('Error resetting generation status on navigation', error);
        }
      })();

      resetVideoState();

      statusResetPromise.finally(() => {
        safeRuntimeSendMessage({ type: 'VIDEO_CHANGED' });

        // Reinitialize for new video after status reset completes
        setTimeout(async () => {
          await init();
          autoInitializeModels();
        }, 1000);
      });
    } else if (!newVideoId) {
      currentUrl = window.location.href;
      const previousVideoId = videoId;
      resetVideoState();

      const cleanupPromise = (async () => {
        if (!previousVideoId) return;
        try {
          await clearGenerationStatus(previousVideoId);
        } catch (error) {
          logStorageError('Error clearing generation status after leaving video', error);
        }
      })();

      cleanupPromise.finally(() => {
        safeRuntimeSendMessage({ type: 'VIDEO_CHANGED' });
      });
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });