let videoElement = null;
let transcriptData = null;
let currentSegmentIndex = 0;
let quizActive = false;
let videoId = null;
let finalQuizShown = false;
let videoSegments = [];
let monitorAttached = false;
let shownSegmentsSet = new Set();
let seekbarObserver = null;
let indicatorsAllowed = false;
let indicatorsAdded = false;
let userSettings = { questionCount: 1, autoQuiz: true, finalQuizEnabled: true, enabled: true, theme: 'dark' };
let finalQuizQuestions = null;
let finalQuizGenerating = false;
let transcriptProcessStarted = false;

async function loadUserSettings() {
  try {
    const result = await chrome.storage.local.get('learntube_settings');
    if (result?.learntube_settings) {
      userSettings = { ...userSettings, ...result.learntube_settings };
      if (!userSettings.theme) {
        userSettings.theme = 'dark';
      }
    }
  } catch (error) {
    if (error.message && error.message.includes('Extension context invalidated')) {
      console.log('LearnTube: Extension reloaded, using default settings');
    } else {
      console.error('LearnTube: Error loading settings:', error);
    }
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

    await chrome.storage.local.set({ learntube_progress: progress });
  } catch (error) {
    if (error.message && error.message.includes('Extension context invalidated')) {
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
      // close after 2 seconds
      setTimeout(closeTranscriptPanel, 2000);
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
  const totalDuration = Math.max(
    videoElement?.duration || 0,
    last ? last.start + (last.duration || 0) : 0
  );

  const {
    FINAL_QUIZ_TRIGGER_PERCENTAGE = 0.92,
    SEGMENT_DURATION = 180
  } = CONFIG || {};

  const cutoffTime = totalDuration * FINAL_QUIZ_TRIGGER_PERCENTAGE;
  const minutes = totalDuration / 60;
  let segmentDuration = Math.floor(cutoffTime / Math.ceil(minutes / 6));

  // Clamp segment duration between 2 and 8 minutes
  segmentDuration = Math.max(120, Math.min(480, segmentDuration));

  const minGapBeforeFinalQuiz = 90;

  const segments = [];
  let segStart = 0;
  let tIdx = 0;

  while (segStart < cutoffTime - minGapBeforeFinalQuiz) {
    const segEnd = Math.min(segStart + segmentDuration, cutoffTime - minGapBeforeFinalQuiz);
    const entries = [];

    while (tIdx < transcript.length && transcript[tIdx].start < segEnd) {
      const entry = transcript[tIdx];
      if (entry.start >= segStart) entries.push(entry);
      tIdx++;
    }

    if (entries.length) {
      const lastEntry = entries.at(-1);
      const actualEnd = lastEntry.start + (lastEntry.duration || 0);

      if (actualEnd > cutoffTime - minGapBeforeFinalQuiz) break;

      segments.push({
        start: segStart,
        end: actualEnd,
        text: entries.map(e => e.text).join(' '),
        entries
      });
    }

    segStart += segmentDuration;
  }
  console.log(`LearnTube: segmentTranscript - created ${segments.length} segments`);
  return segments;
}


async function pregenerateAllQuizzes() {
  if (videoSegments.length === 0) return;

  let finalQuizPromise = null;
  if (!finalQuizGenerating && !finalQuizQuestions) {
    finalQuizGenerating = true;
    const allText = videoSegments.map(s => s.text).join(' ');
    const totalDuration = videoSegments[videoSegments.length - 1]?.end || videoElement?.duration || 0;
    const finalQCount = Math.floor(Math.random() * (CONFIG.FINAL_QUIZ_QUESTIONS_MAX - CONFIG.FINAL_QUIZ_QUESTIONS_MIN + 1)) + CONFIG.FINAL_QUIZ_QUESTIONS_MIN;

    finalQuizPromise = summarizeTranscript(allText)
      .then(summary => {
        const summaryText = summary || allText;
        return generateQuiz({ start: 0, end: totalDuration, text: summaryText }, finalQCount);
      })
      .then(qs => { if (qs?.length) finalQuizQuestions = qs; })
      .catch(() => { })
      .finally(() => { finalQuizGenerating = false; });
  }

  try {
    const firstSegment = videoSegments[0];
    firstSegment.questions = await generateQuiz(firstSegment, userSettings.questionCount || 1);
    updateSeekbarIndicator(0, true);
    if (!indicatorsAllowed) indicatorsAllowed = true;
    addIndicatorForSegment(0);
  } catch (error) {
    videoSegments[0].questions = generateFallbackQuestions(videoSegments[0], userSettings.questionCount || 1);
    updateSeekbarIndicator(0, true);
  }

  // Generate remaining quizzes with optimized batching
  const batchSize = 3;
  for (let i = 1; i < videoSegments.length; i += batchSize) {
    const batch = [];
    const end = Math.min(i + batchSize, videoSegments.length);

    for (let j = i; j < end; j++) {
      const index = j;
      const segment = videoSegments[index];

      batch.push(
        generateQuiz(segment, userSettings.questionCount || 1)
          .then(questions => {
            segment.questions = questions;
            updateSeekbarIndicator(index, true);
            addIndicatorForSegment(index);
          })
          .catch(() => {
            segment.questions = generateFallbackQuestions(segment, userSettings.questionCount || 1);
            updateSeekbarIndicator(index, true);
          })
      );
    }

    await Promise.all(batch);
    if (end < videoSegments.length) await new Promise(r => setTimeout(r, 200));
  }

  // Wait for final quiz to complete before caching
  if (finalQuizPromise) {
    await finalQuizPromise;
    console.log('LearnTube: Final quiz generation completed');
  }

  cacheAllQuizzes(extractVideoId(), videoSegments);
}

function cacheTranscript(videoId, transcript) {
  try {
    localStorage.setItem(`learntube_transcript_${videoId}`, JSON.stringify(transcript));
  } catch (e) { }
}

function getCachedTranscript(videoId) {
  try {
    const cached = localStorage.getItem(`learntube_transcript_${videoId}`);
    return cached ? JSON.parse(cached) : null;
  } catch (e) {
    return null;
  }
}

function cacheAllQuizzes(videoId, segments) {
  try {
    const cacheData = {
      version: '1.1',
      timestamp: Date.now(),
      segmentCount: segments.length,
      segments: segments,
      finalQuiz: finalQuizQuestions
    };
    localStorage.setItem(`learntube_quiz_${videoId}`, JSON.stringify(cacheData));

    const finalQuizStatus = finalQuizQuestions && finalQuizQuestions.length > 0
      ? `with ${finalQuizQuestions.length} final quiz questions`
      : 'without final quiz';
    console.log(`LearnTube: Cached ${segments.length} segments ${finalQuizStatus}`);
  } catch (e) {
    console.error('LearnTube: Error caching quizzes:', e);
  }
}

function getCachedQuizzes(videoId) {
  try {
    const cached = localStorage.getItem(`learntube_quiz_${videoId}`);
    if (!cached) return null;

    const cacheData = JSON.parse(cached);

    if (!cacheData || !cacheData.version || !cacheData.segments) {
      console.log('LearnTube: Invalid or outdated cache format, clearing cache');
      clearCachedData(videoId);
      return null;
    }

    return cacheData;
  } catch (e) {
    console.error('LearnTube: Error loading cached quizzes:', e);
    return null;
  }
}

function clearCachedData(videoId) {
  try {
    // Clear quiz cache
    const quizCacheKey = `learntube_quiz_${videoId}`;
    localStorage.removeItem(quizCacheKey);

    // Clear transcript cache
    const transcriptCacheKey = `learntube_transcript_${videoId}`;
    localStorage.removeItem(transcriptCacheKey);

  } catch (error) {
    console.error('LearnTube: Error clearing cache:', error);
  }
}

function getCacheInfo() {
  try {
    const cacheInfo = {
      videoId: videoId,
      cachedQuizzes: 0,
      totalSegments: videoSegments ? videoSegments.length : 0,
      cacheKeys: []
    };

    for (let index = 0; index < 10; index++) {
      const cacheKey = `learntube_quiz_${videoId}_${index}`;
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        cacheInfo.cachedQuizzes++;
        cacheInfo.cacheKeys.push(cacheKey);
      }
    }

    return cacheInfo;
  } catch (error) {
    console.error('LearnTube: Error getting cache info:', error);
    return null;
  }
}

window.learntubeCacheInfo = getCacheInfo;
window.learntubeClearCache = clearCachedData;

function updateSeekbarIndicator(segmentIndex, isReady) {
  const indicators = document.querySelectorAll('.learntube-quiz-indicator');
  if (indicators[segmentIndex]) {
    const indicator = indicators[segmentIndex];
    if (isReady) {
      indicator.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      indicator.title = `Quiz ${segmentIndex + 1} - Ready!`;
    } else {
      indicator.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
      indicator.title = `Quiz ${segmentIndex + 1} - Generating...`;
    }
  }
}

async function summarizeTranscript(fullText) {
  try {
    if (typeof Summarizer === 'undefined') {
      console.log('LearnTube: Summarizer API not available, using full text');
      return null;
    }

    const availability = await Summarizer.availability();
    if (availability !== 'available') {
      console.log('LearnTube: Summarizer not available, using full text');
      return null;
    }

    const summarizer = await Summarizer.create({
      type: 'key-points',
      format: 'plain-text',
      length: 'medium',
      sharedContext: 'This is educational video content.',
      outputLanguage: 'en'
    });

    const summary = await summarizer.summarize(fullText);
    console.log('LearnTube: Successfully summarized transcript for final quiz');

    return summary;
  } catch (error) {
    console.error('LearnTube: Error summarizing transcript:', error);
    return null;
  }
}

async function generateQuiz(segment, desiredCount = 2) {
  try {
    if (typeof LanguageModel === 'undefined') {
      return generateFallbackQuestions(segment, desiredCount);
    }
    const availability = await LanguageModel.availability();
    if (availability !== 'available') {
      return generateFallbackQuestions(segment, desiredCount);
    }
    const session = await LanguageModel.create({
      temperature: 0.7,
      topK: 40,
      maxOutputTokens: 1000
    });
    const n = Math.max(1, Math.min(4, desiredCount));
    const header = `You are generating high-quality multiple-choice questions strictly from the provided video content. Do not use outside knowledge.

Context:
- Video segment start (s): ${Math.round(segment.start || 0)}
- Video segment end (s): ${Math.round(segment.end || (segment.start || 0) + (segment.duration || 0))}
- Video content:
"""
${segment.text}
"""

Task:
- Write EXACTLY ${n} questions (Q1..Q${n}) with 4 options each (A–D).
- Each question must test a distinct, non-trivial point from the video content.
- Keep questions clear and specific; avoid trivia and vague wording.
- Use the video's terminology; do not invent facts not present in the content.
- Options should be concise, mutually exclusive, and plausible; avoid jokes and "All of the above/None of the above".
- Balance option length so the correct one doesn't stand out.
- Ensure exactly one correct answer per question.

Difficulty/coverage:
- At least one question should assess applied understanding or why/how (beyond recall).
- Another can assess key definitions or contrasts from the video segment.

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
    return parseQuizResponse(response);
  } catch (error) {
    return generateFallbackQuestions(segment, desiredCount);
  }
}

function generateFallbackQuestions(segment, desiredCount = 2) {
  const n = Math.max(1, Math.min(4, desiredCount));
  const words = segment.text.split(' ').filter(word => word.length > 4);
  const randomWords = words.sort(() => 0.5 - Math.random()).slice(0, n);

  return randomWords.map((word) => ({
    question: `What is mentioned about "${word}" in this segment?`,
    options: [
      `It's important for understanding the topic`,
      `It's a key concept discussed`,
      `It's mentioned as an example`,
      `It's the main focus`
    ],
    correct: 1
  }));
}

function parseQuizResponse(response) {
  if (typeof response !== 'string') {
    response = String(response);
  }
  if (!response || response.trim().length === 0) {
    return generateFallbackQuestions({ text: 'fallback' });
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
        if (line.match(/^[A-D]\)/)) {
          options.push(line.substring(3).trim());
        } else if (line.startsWith('Correct:')) {
          const correctLetter = line.split(':')[1].trim();
          correct = correctLetter.charCodeAt(0) - 65;
        }
      }
      if (question && options.length >= 2 && correct >= 0) {
        questions.push({ question, options, correct });
      }
    }
    return questions.length > 0 ? questions : generateFallbackQuestions({ text: 'fallback' });
  } catch (error) {
    console.error('LearnTube: Error parsing quiz response:', error);
    return generateFallbackQuestions({ text: 'fallback' });
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
  if (quizActive) {
    removeOverlay();
    quizActive = false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const allText = segments.map(s => s.text).join(' ');
  const totalDuration = segments[segments.length - 1]?.end || (videoElement && videoElement.duration) || 0;

  try {
    let questions = finalQuizQuestions && finalQuizQuestions.length ? finalQuizQuestions : null;
    if (!questions) {
      const finalQCount = Math.floor(Math.random() * (CONFIG.FINAL_QUIZ_QUESTIONS_MAX - CONFIG.FINAL_QUIZ_QUESTIONS_MIN + 1)) + CONFIG.FINAL_QUIZ_QUESTIONS_MIN;
      const summary = await summarizeTranscript(allText);
      const summaryText = summary || allText;
      const finalSegment = { start: 0, end: totalDuration, text: summaryText };
      questions = await generateQuiz(finalSegment, finalQCount);
    }
    if (questions && questions.length > 0) {
      showQuiz(questions, segments.length);
    } else {
      showFallbackSummary(segments);
    }
  } catch (error) {
    showFallbackSummary(segments);
  }
}

function showFallbackSummary(segments) {
  const keyPoints = segments.map((segment, index) =>
    `• ${segment.text.substring(0, 100)}...`
  ).slice(0, 5);

  const summary = `Key points from this video:\n\n${keyPoints.join('\n')}`;
  showSummaryOverlay(summary, segments);
}

function showSummaryOverlay(summary, segments) {
  removeOverlay();
  const closeFunctionName = `learntubeCloseSummary_${Date.now()}`;
  createOverlay(`
    <div class="learntube-card" style="z-index: 999999; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); max-width: 600px; width: 90%;">
      <div class="learntube-header">
        <div class="learntube-icon">📝</div>
        <div class="learntube-title">
          <h2>Video Summary</h2>
          <p class="learntube-subtitle">You've completed the video!</p>
        </div>
        <button class="learntube-close" onclick="window.${closeFunctionName}()">×</button>
      </div>
      
      <div class="learntube-summary">
        <h3 class="summary-title">📋 Summary</h3>
        <p class="summary-text">${summary}</p>
      </div>
      
      <div class="learntube-stats">
        <div class="stat-card">
          <div class="stat-number">${segments.length}</div>
          <div class="stat-label">Segments</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${segments.reduce((total, s) => total + s.entries.length, 0)}</div>
          <div class="stat-label">Captions</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${Math.round(segments[segments.length - 1]?.end || 0)}s</div>
          <div class="stat-label">Duration</div>
        </div>
      </div>
      
      <div class="learntube-actions">
        <button class="learntube-button learntube-button-primary" onclick="window.${closeFunctionName}()">
          Great! Continue Learning
        </button>
      </div>
    </div>
  `);
  window[closeFunctionName] = () => {
    removeOverlay();
    delete window[closeFunctionName];
  };
  window.learntubeCloseSummary = window[closeFunctionName];
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
  if (monitorAttached) return;

  monitorAttached = true;

  let transcriptFetched = false;
  let lastCheckTime = 0; // Track last check to avoid duplicate triggers

  const checkProgress = () => {
    if (!videoElement) {
      return;
    }
    if (quizActive) {
      lastCheckTime = videoElement.currentTime;
      return;
    }

    // If extension is disabled, don't do anything
    if (!userSettings.enabled) {
      return;
    }

    //when Enable LearnTube AI  is off or (Auto quiz or Final Quiz ) are off do not startTranscriptProcess
    if (!userSettings.autoQuiz && !userSettings.finalQuiz) {
      return;
    }

    const currentTime = videoElement.currentTime;
    const videoDuration = videoElement.duration;

    // Start transcript fetching after 3% of video watched (or immediately if already past that)
    if (!transcriptFetched && videoDuration > 0) {
      const startThreshold = videoDuration * 0.03; // 3% of video
      if (currentTime >= startThreshold) {
        transcriptFetched = true;
        startTranscriptProcess();
      }
      return;
    }

    // If transcript not fetched yet, don't check for segments
    if (!transcriptFetched || !videoSegments || videoSegments.length === 0) {
      return;
    }

    // If autoQuiz is disabled, don't automatically trigger quizzes
    if (!userSettings.autoQuiz) {
      return;
    }

    const skipThreshold = videoDuration * 0.03;
    if (currentTime < skipThreshold) {
      return;
    }

    // Check ALL segments to find the one whose END we just reached
    // This handles seeking/skipping properly
    for (let i = 0; i < videoSegments.length; i++) {
      const segment = videoSegments[i];
      if (!segment || typeof segment.end !== 'number') continue;

      // Check if we've crossed this segment's END time (3s window)
      const isAtSegmentEnd = currentTime >= segment.end && currentTime < (segment.end + 3);

      // Detect if user is seeking (time jumped more than 3 seconds)
      const timeDiff = Math.abs(currentTime - lastCheckTime);
      const isBigSeek = timeDiff > 3 && lastCheckTime > 0;

      // If big seek, reset shown segments that we skipped over
      if (isBigSeek) {
        if (currentTime < lastCheckTime) {
          for (let j = 0; j < videoSegments.length; j++) {
            if (videoSegments[j].start > currentTime) {
              shownSegmentsSet.delete(j);
            }
          }
        }
      }

      // Show quiz if at the segment END and not shown yet
      if (isAtSegmentEnd && !shownSegmentsSet.has(i)) {
        console.log(`LearnTube: Auto-triggering quiz for segment ${i + 1} at time ${currentTime.toFixed(1)}s (segment end: ${segment.end.toFixed(1)}s)`);

        // Mark as shown before pausing to avoid race conditions
        shownSegmentsSet.add(i);

        videoElement.pause();

        // Use pre-generated quiz
        if (segment.questions && segment.questions.length > 0) {
          showQuiz(segment.questions, i);
        } else {
          console.log(`LearnTube: Generating quiz on-demand for segment ${i + 1} (start=${Math.round(segment.start || 0)}s)`);
          generateQuiz(segment).then(questions => {
            if (questions && questions.length > 0) {
              console.log(`LearnTube: Completed on-demand quiz for segment ${i + 1} with ${questions.length} question(s)`);
              showQuiz(questions, i);
            } else {
              if (videoElement) videoElement.play();
            }
          }).catch(err => {
            console.error(`LearnTube: On-demand quiz generation failed for segment ${i + 1}:`, err);
            if (videoElement) videoElement.play();
          });
        }

        break; // Only show one quiz at a time
      }
    }

    lastCheckTime = currentTime;
  };

  videoElement.addEventListener('timeupdate', checkProgress);

  // Trigger final quiz before video end
  const triggerFinalIfDue = () => {
    if (!videoElement) return;
    if (!userSettings.enabled) return;
    if (!userSettings.finalQuizEnabled) return;
    if (!userSettings.autoQuiz) return;
    if (finalQuizShown) return;
    if (!Array.isArray(videoSegments) || videoSegments.length === 0) return;
    const duration = videoElement.duration || 0;
    if (!duration || isNaN(duration)) return;
    const triggerTime = duration * (CONFIG.FINAL_QUIZ_TRIGGER_PERCENTAGE || 0.92);
    if (videoElement.currentTime >= triggerTime) {
      finalQuizShown = true;
      setTimeout(async () => {
        try {
          await showFinalQuiz(videoSegments);
        } catch (error) {
          console.error('LearnTube: Error showing final quiz:', error);
        }
      }, 500);
    }
  };
  videoElement.addEventListener('timeupdate', triggerFinalIfDue);

  videoElement.addEventListener('ended', async () => {
    if (!userSettings.enabled) return; // Check if extension is enabled
    if (!userSettings.finalQuizEnabled) return; // Check if final quiz is enabled

    if (!finalQuizShown && videoSegments.length > 0) {
      finalQuizShown = true;
      // Only auto-show final quiz if autoQuiz is enabled
      if (userSettings.autoQuiz) {
        setTimeout(async () => {
          try {
            await showFinalQuiz(videoSegments);
          } catch (error) {
            console.error('LearnTube: Error showing final quiz:', error);
          }
        }, 1000);
      }
    } else {
      if (finalQuizShown) {
      } else if (videoSegments.length === 0) {
      }
    }
  });
}

// Start the transcript fetching and quiz generation process
async function startTranscriptProcess() {
  if (transcriptProcessStarted) {
    console.log('LearnTube: Transcript process already started, skipping duplicate call');
    return;
  }
  transcriptProcessStarted = true;

  const currentVideoId = extractVideoId();
  await loadUserSettings();

  // Try to load cached quizzes first
  const cachedData = getCachedQuizzes(currentVideoId);
  if (cachedData?.segments?.length) {
    console.log('LearnTube: Cache hit - loaded', cachedData.segments.length, 'segments');

    videoSegments = cachedData.segments;
    finalQuizQuestions = cachedData.finalQuiz || null;

    if (finalQuizQuestions?.length) {
      console.log(`LearnTube: Final quiz also loaded from cache (${finalQuizQuestions.length} questions)`);
    } else {
      console.log('LearnTube: Final quiz not found in cache');
    }

    // Identify segments missing questions
    const missingIndices = [];
    let hasAnyQuestions = false;

    videoSegments.forEach((seg, i) => {
      if (!seg.questions?.length) missingIndices.push(i);
      else hasAnyQuestions = true;
    });

    // Show indicators for segments with existing questions
    if (hasAnyQuestions) {
      indicatorsAllowed = true;
      addQuizIndicatorsToSeekbar();
    }

    // Generate missing quizzes in parallel
    if (missingIndices?.length) {
      console.log(`LearnTube: ${missingIndices.length} segments missing questions, generating in parallel`);

      await Promise.all(
        missingIndices.map(async (i) => {
          const segment = videoSegments[i];
          try {
            segment.questions = await generateQuiz(segment, userSettings.questionCount || 1);
          } catch (err) {
            segment.questions = generateFallbackQuestions(segment, userSettings.questionCount || 1);
          }
          updateSeekbarIndicator(i, true);
          if (!indicatorsAllowed) {
            indicatorsAllowed = true;
            addQuizIndicatorsToSeekbar();
          }
          console.log(`LearnTube: Generated quiz for segment ${i + 1}`);
        })
      );

      cacheAllQuizzes(currentVideoId, videoSegments);
      console.log('LearnTube: All missing quizzes generated and cached');
    }

    // Ensure indicators are shown
    indicatorsAllowed = true;
    addQuizIndicatorsToSeekbar();
    setTimeout(() => indicatorsAllowed && addQuizIndicatorsToSeekbar(), 1500);
    return;
  }

  console.log('LearnTube: Cache miss - fetching transcript');

  // Fetch transcript if not cached
  let transcript = getCachedTranscript(currentVideoId);
  if (!transcript) {
    transcript = await getTranscript();
    if (!transcript?.length) {
      return;
    }

    cacheTranscript(currentVideoId, transcript);
  }

  // Segment transcript and pre-generate quizzes
  videoSegments = segmentTranscript(transcript);
  await pregenerateAllQuizzes();

  indicatorsAllowed = true;
  addQuizIndicatorsToSeekbar();
}

// Clear seekbar indicators
function clearSeekbarIndicators() {
  const existingIndicators = document.querySelectorAll('.learntube-quiz-indicator');
  existingIndicators.forEach(indicator => indicator.remove());
  indicatorsAdded = false;
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

  console.log(`LearnTube: Adding ${videoSegments.length} indicators to seekbar`);

  // Find the seekbar container with more options
  const seekbarSelectors = [
    '.ytp-progress-bar-container',
    '.ytp-progress-bar',
    '#progress-bar',
    '.ytp-chapter-container',
    '.ytp-chapters-container',
    '.ytp-progress-list',
    '.html5-progress-bar-container',
    '.html5-progress-bar'
  ];

  let seekbarContainer = null;
  for (const selector of seekbarSelectors) {
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
  if (!videoElement.duration || isNaN(videoElement.duration) || videoElement.duration === 0) {
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
    const duration = videoElement.duration || 0;
    const anchorTime = (() => {
      const end = typeof segment.end === 'number' ? segment.end : undefined;
      const start = typeof segment.start === 'number' ? segment.start : 0;
      let t = typeof end === 'number' ? end : start;
      if (!duration || isNaN(duration) || duration <= 0) return t;
      // Clamp inside duration to avoid off-by-one/rounding placing beyond the bar
      t = Math.max(0, Math.min(t, Math.max(0, duration - 0.25)));
      return t;
    })();
    if (!isNaN(anchorTime)) {
      const positionPercent = ((anchorTime / (videoElement.duration || 1)) * 100).toFixed(4);

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
        background: ${segment.questions && segment.questions.length > 0 ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #f59e0b, #d97706)'} !important;
        border: 2px solid white !important;
        border-radius: 50% !important;
        transform: translate(-50%, -50%) !important;
        z-index: 999999 !important;
        cursor: pointer !important;
        transition: all 0.3s ease !important;
        pointer-events: auto !important;
      `;

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

      // Add tooltip
      indicator.title = segment.questions && segment.questions.length > 0
        ? `Quiz ${index + 1} (end @ ${Math.round(anchorTime)}s) - Ready!`
        : `Quiz ${index + 1} (end @ ${Math.round(anchorTime)}s) - Generating...`;

      // Add to seekbar
      seekbarContainer.appendChild(indicator);
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
    if (duration && !isNaN(duration)) {
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
          finalQuizShown = true;
          try {
            await showFinalQuiz(videoSegments);
          } catch { }
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
          console.log('LearnTube: Seekbar changed — re-adding indicators');
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
    background: ${segment.questions && segment.questions.length > 0 ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #f59e0b, #d97706)'} !important;
    border: 2px solid white !important;
    border-radius: 50% !important;
    transform: translate(-50%, -50%) !important;
    z-index: 999999 !important;
    cursor: pointer !important;
    transition: all 0.3s ease !important;
    pointer-events: auto !important;
  `;

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
  indicator.title = segment.questions && segment.questions.length > 0
    ? `Quiz ${index + 1} (end @ ${Math.round(anchorTime)}s) - Ready!`
    : `Quiz ${index + 1} (end @ ${Math.round(anchorTime)}s) - Generating...`;

  seekbarContainer.appendChild(indicator);
}

// Monitor video progress to update indicator states
function startIndicatorMonitoring() {
  if (!videoElement) return;

  const updateIndicators = () => {
    const currentTime = videoElement.currentTime;
    const indicators = document.querySelectorAll('.learntube-quiz-indicator');

    indicators.forEach((indicator, index) => {
      const segment = videoSegments[index];
      if (segment && typeof segment.end === 'number') {
        if (currentTime >= segment.end) {
          // Quiz has been reached at END
          indicator.style.background = 'linear-gradient(135deg, #10b981, #059669)';
          indicator.title = `Quiz ${index + 1} - Completed`;
        } else {
          // Quiz not yet reached
          const timeUntil = Math.max(0, Math.round(segment.end - currentTime));
          indicator.style.background = 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
          indicator.title = `Quiz ${index + 1} in ${timeUntil}s`;
        }
      }
    });
  };

  // Update indicators every second
  const indicatorInterval = setInterval(updateIndicators, 1000);

  // Clean up when video changes
  const cleanup = () => {
    clearInterval(indicatorInterval);
  };

  // Clean up on video change
  videoElement.addEventListener('loadstart', cleanup);
  videoElement.addEventListener('ended', cleanup);
}

async function init() {
  // Load settings first
  await loadUserSettings();
  
  // Check if extension is enabled
  if (!userSettings.enabled) {
    console.log('LearnTube: Extension is disabled, skipping initialization');
    return;
  }

  videoId = extractVideoId();
  if (!videoId) {
    return;
  }

  videoElement = document.querySelector('video');
  if (!videoElement) {
    return;
  }

  videoElement.addEventListener('loadstart', () => {
    monitorAttached = false;
    setTimeout(monitorVideo, 0);
  });

  monitorVideo();
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'clearCache') {
    const currentVideoId = extractVideoId();
    if (currentVideoId) {
      clearCachedData(currentVideoId);
      sendResponse({ success: true, message: 'Cache cleared for this video' });
    } else {
      sendResponse({ success: false, message: 'No video ID found' });
    }
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
        if (error.message && error.message.includes('Extension context invalidated')) {
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
    checkModelStatus().then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.action === 'hasCache') {
    try {
      const currentVideoId = extractVideoId();
      if (!currentVideoId) {
        sendResponse({ success: false, hasCache: false });
        return true;
      }
      const cachedData = getCachedQuizzes(currentVideoId);
      const hasCache = cachedData && cachedData.segments && cachedData.segments.length > 0;
      sendResponse({ success: true, hasCache });
    } catch (error) {
      sendResponse({ success: false, hasCache: false });
    }
    return true;
  }

  if (message.action === 'downloadModel') {
    downloadModel(message.modelType).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (message.action === 'updateSettings') {
    loadUserSettings().then(async () => {
      // If extension was just disabled, clean up
      if (!userSettings.enabled) {
        console.log('LearnTube: Extension disabled, cleaning up');
        removeOverlay();
        clearSeekbarIndicators();
        quizActive = false;
      } else {
        // If extension was just enabled and we have a video, reinitialize
        const currentVideoId = extractVideoId();
        if (currentVideoId && !videoElement) {
          console.log('LearnTube: Extension enabled, reinitializing');
          await init();
        }
      }
      sendResponse({ success: true });
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


// Download model function
async function downloadModel(modelType) {
  try {
    if (modelType === 'languageModel') {
      if (typeof LanguageModel !== 'undefined') {
        // Trigger model download by creating a session with progress monitor
        const session = await LanguageModel.create({
          temperature: 0.7,
          topK: 40,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const percentage = Math.round(e.loaded * 100);
              console.log(`LearnTube: Language Model downloaded ${percentage}%`);

              // Send progress update to popup
              chrome.runtime.sendMessage({
                type: 'MODEL_DOWNLOAD_PROGRESS',
                modelType: 'languageModel',
                progress: percentage
              }).catch(() => { });
            });
          }
        });

        // Destroy the session after triggering download
        if (session && typeof session.destroy === 'function') {
          session.destroy();
        }

        console.log('LearnTube: Language Model download initiated');
        return { success: true, message: 'Download initiated' };
      } else {
        return { success: false, message: 'LanguageModel API not available' };
      }
    } else if (modelType === 'summarizer') {
      if (typeof Summarizer !== 'undefined') {
        // Trigger model download by creating a summarizer with progress monitor
        const summarizer = await Summarizer.create({
          type: 'key-points',
          format: 'plain-text',
          length: 'medium',
          sharedContext: 'This is educational video content.',
          outputLanguage: 'en',
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const percentage = Math.round(e.loaded * 100);
              console.log(`LearnTube: Summarizer downloaded ${percentage}%`);

              // Send progress update to popup
              chrome.runtime.sendMessage({
                type: 'MODEL_DOWNLOAD_PROGRESS',
                modelType: 'summarizer',
                progress: percentage
              }).catch(() => { });
            });
          }
        });

        // Destroy the summarizer after triggering download
        if (summarizer && typeof summarizer.destroy === 'function') {
          summarizer.destroy();
        }

        console.log('LearnTube: Summarizer download initiated');
        return { success: true, message: 'Download initiated' };
      } else {
        return { success: false, message: 'Summarizer API not available' };
      }
    } else {
      return { success: false, message: 'Unknown model type' };
    }
  } catch (error) {
    console.error('LearnTube: Error downloading model:', error);
    return { success: false, message: 'Download failed: ' + error.message };
  }
}

// Auto-initialize models on page load
async function autoInitializeModels() {
  try {
    // Check LanguageModel
    if (typeof LanguageModel !== 'undefined') {
      const lmAvailability = await LanguageModel.availability();
      console.log('LearnTube: LanguageModel availability:', lmAvailability);

      if (lmAvailability === 'downloadable' || lmAvailability === 'available') {
        try {
          const session = await LanguageModel.create({
            temperature: 0.7,
            topK: 40,
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                const percentage = Math.round(e.loaded * 100);
                console.log(`LearnTube: Language Model auto-init downloaded ${percentage}%`);

                // Send progress update to popup
                chrome.runtime.sendMessage({
                  type: 'MODEL_DOWNLOAD_PROGRESS',
                  modelType: 'languageModel',
                  progress: percentage
                }).catch(() => { });
              });
            }
          });

          if (session && typeof session.destroy === 'function') {
            session.destroy();
          }

          console.log('LearnTube: LanguageModel initialized successfully');
        } catch (err) {
          console.log('LearnTube: LanguageModel initialization in progress or failed:', err.message);
        }
      }
    }

    // Check Summarizer
    if (typeof Summarizer !== 'undefined') {
      const smAvailability = await Summarizer.availability();
      console.log('LearnTube: Summarizer availability:', smAvailability);

      if (smAvailability === 'downloadable' || smAvailability === 'available') {
        try {
          const summarizer = await Summarizer.create({
            type: 'key-points',
            format: 'plain-text',
            length: 'medium',
            sharedContext: 'This is educational video content.',
            outputLanguage: 'en',
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                const percentage = Math.round(e.loaded * 100);
                console.log(`LearnTube: Summarizer auto-init downloaded ${percentage}%`);

                // Send progress update to popup
                chrome.runtime.sendMessage({
                  type: 'MODEL_DOWNLOAD_PROGRESS',
                  modelType: 'summarizer',
                  progress: percentage
                }).catch(() => { });
              });
            }
          });

          if (summarizer && typeof summarizer.destroy === 'function') {
            summarizer.destroy();
          }

          console.log('LearnTube: Summarizer initialized successfully');
        } catch (err) {
          console.log('LearnTube: Summarizer initialization in progress or failed:', err.message);
        }
      }
    }
  } catch (error) {
    console.log('LearnTube: Error during model auto-initialization:', error.message);
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
      console.log('LearnTube: Video changed from', videoId, 'to', newVideoId);
      currentUrl = window.location.href;

      // Reset all state variables
      videoId = null;
      currentSegmentIndex = 0;
      quizActive = false;
      finalQuizShown = false;
      videoSegments = [];
      monitorAttached = false;
      shownSegmentsSet.clear();
      indicatorsAllowed = false;
      indicatorsAdded = false;
      finalQuizQuestions = null;
      finalQuizGenerating = false;
      transcriptProcessStarted = false;

      // Clear UI elements
      clearSeekbarIndicators();
      removeOverlay();

      // Reinitialize for new video
      setTimeout(async () => {
        await init();
        autoInitializeModels();
      }, 1000);
    } else if (!newVideoId) {
      currentUrl = window.location.href;
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });