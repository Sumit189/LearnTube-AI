# LearnTube AI

A Chrome extension that transforms passive YouTube watching into active learning by generating AI-powered quizzes during videos. Think of it like Coursera's quiz system, but automatically applied to any YouTube video you watch.


## Research Inspiration
We've all been there: watching a 45-minute YouTube video only to realize halfway through that our mind has completely wandered. Passive watching is easy, but retention is hard. Platforms like Coursera show that active learning with quizzes dramatically improves knowledge retention, but that model only works for structured courses.

Recent studies reinforce the importance of interactivity in video-based learning.
Recent studies reinforce the importance of interactivity in video-based learning.

- **Chan et al. (2025)** found that embedding low-stakes quizzes within instructional videos significantly boosts learner attention and comprehension by forcing active retrieval. [In-lecture quizzes improve online learning for university and community college students](https://pubmed.ncbi.nlm.nih.gov/40175612/)

- **Haerawan et al. (2024)** provided empirical evidence supporting the efficacy of in-video quizzes in enhancing student engagement and learning outcomes. Conducted with 200 undergraduate students across various disciplines, the study compared interactive videos (incorporating quizzes, clickable hotspots, and branching scenarios) with traditional video lectures over a 6-week online course. The findings revealed that the interactive video group exhibited a 45% higher interaction rate and 30% longer viewing time compared to the control group. Furthermore, the experimental group demonstrated a 25% improvement in post-test scores, indicating enhanced knowledge retention and understanding. [The Effectiveness of Interactive Videos in Increasing Student Engagement in Online Learning](https://pubmed.ncbi.nlm.nih.gov/40175612/)

- **McGill et al. (2015)** demonstrated that active learning through video quizzes and interactive annotations improves student engagement and knowledge retention in engineering and technical subjects. [Active learning in video lectures](https://ieeexplore.ieee.org/document/7122326)

These findings highlight a clear gap. YouTube is home to millions of high-quality educational videos, but it lacks the mechanisms that make structured learning platforms so effective. 

I wondered if we could bring that same accountability to any YouTube video, such as Khan Academy, MIT lectures, or 3Blue1Brown, without requiring creators to manually add quizzes. When Chrome announced built-in AI capabilities, I realized it could finally be done entirely client-side, with no servers, no API keys, and complete privacy. However, on-device AI models require [significant system resources](https://developer.chrome.com/docs/ai/get-started) (22GB+ storage, 16GB+ RAM, and compatible hardware), so I added a cloud-based API option to ensure the extension works smoothly for all users.

## What It Is

LearnTube AI is a Chrome extension that analyzes video transcripts and generates contextual quiz questions using AI. The extension pauses videos at natural topic transitions to quiz you on what you just learned, then gives you a comprehensive final quiz when the video ends.

**Two AI Provider Options:**

1. **On Device (Default)**: Uses Chrome's built-in Gemini Nano AI - no external API keys required. All AI processing happens locally on your machine using Chrome's built-in AI APIs. No data leaves your browser, and it works offline once the models are downloaded.

2. **Gemini API**: Uses Google's cloud-based Gemini API for faster processing and more powerful AI capabilities. Requires a free API key from Google AI Studio. Data is processed by Google's servers but your API key is stored locally.

## Key Features

- Automatic transcript extraction and segmentation for any captioned YouTube video
- Mid-video and final quizzes with multiple-choice questions and detailed explanations
- Visual seekbar markers and overlay UI to keep quizzes contextual and non-intrusive
- Popup dashboard for managing AI model downloads, themes, and learning statistics
- Local caching of quizzes and progress with one-click controls to refresh or reset

## How It Works

### Architecture

The extension consists of three main components working together with dual AI provider support:

**Content Script** (`content.js`)
- Injects into YouTube video pages
- Extracts and processes video transcripts by clicking the transcript button and parsing the panel
- Segments transcripts into logical chunks (default 180 seconds each)
- Monitors video playback using `timeupdate` events to trigger quizzes at the right moments
- Generates quiz questions using either Chrome's built-in AI APIs or Google's Gemini API based on user selection
- Displays quiz overlays on top of the video player
- Handles AI provider switching and API key management

**Background Script** (`background.js`)
- Manages extension settings and user progress in Chrome's local storage
- Handles messages between popup and content scripts
- Initializes default settings when extension is installed
- Manages analytics events with AI provider tracking

**Popup UI** (`popup.html`, `popup.js`)
- Provides controls for enabling/disabling features
- AI provider selection (On Device vs Gemini API)
- API key management for Gemini API users
- Shows model status and allows downloading AI models if not available
- Displays user statistics (videos watched, quizzes taken, average score) and lets you share progress for the current video or overall history
- Offers cache management tools to refresh quizzes for the current video or wipe all cached data
- Includes theme selection and other preferences that sync with the in-video experience

### Key Implementation Details

**AI Provider Selection**: Users can choose between two AI providers:
- **On Device AI**: Uses Chrome's built-in Language Model and Summarizer APIs for complete privacy
- **Gemini API**: Uses Google's cloud-based Gemini API for faster processing and enhanced capabilities

**AI Model Management**: 
- **On Device**: Checks if Chrome's Language Model and Summarizer are available using `LanguageModel.availability()` and `Summarizer.availability()`. If not downloaded (status is "downloadable"), users can trigger the download via the popup interface.
- **Gemini API**: Validates API keys and handles authentication with Google's servers. Includes retry logic with exponential backoff for quota management.

**Quiz Generation**: 
- **On Device**: For mid-video quizzes, questions are generated using the Language Model (Prompt API). For the final quiz, the entire transcript is first summarized using the Summarizer API, then the Language Model generates questions based on that summary.
- **Gemini API**: Uses Google's Gemini 2.5 Flash Lite model with chunked processing for large transcripts. Includes automatic retry logic and quota management.

**Caching**: Generated quizzes are stored in Chrome's local storage under the video ID to avoid regenerating them on subsequent views. Users can clear the cache via the popup if they want fresh questions.

**Seekbar Indicators**: Small green dots appear on the YouTube seekbar showing where quizzes will appear. These are dynamically injected as absolutely positioned divs that update as the seekbar resizes.

**Overlay UI**: Quiz overlays are created as custom HTML elements injected into the page with high z-index values to appear above the video player. They include the question, answer options, feedback, and navigation controls.

**Analytics Integration**: Tracks AI provider usage in analytics events, allowing monitoring of which AI provider users prefer and performance metrics for each option.

## Installation (Unpacked Extension)

The extension supports two AI provider options with different installation requirements:

### Prerequisites

#### For On Device AI (Default)

1. **Install Chrome (Stable, Canary, or Dev)**
   - Chrome Stable: https://www.google.com/chrome/
   - Chrome Canary: https://www.google.com/chrome/canary/
   - Chrome Dev: https://www.google.com/chrome/dev/
   - The built-in AI APIs are now available in the latest stable Chrome release

2. **Enable Required Flags**
   - Open `chrome://flags` in Chrome
   - Enable these flags:
     - `Prompt API for Gemini Nano` - Set to "Enabled"
     - `Summarization API for Gemini Nano` - Set to "Enabled"
     - `Enables optimization guide on device` - Set to "Enabled BypassPerfRequirement"
   - Restart Chrome when prompted

3. **Verify AI API Availability**
   - Open DevTools Console (F12) on any page
   - Type: `await LanguageModel.availability()`
   - You should see `"available"` or `"downloadable"`
   - If you see an error or `undefined`, the APIs aren't supported on your system

#### For Gemini API (Alternative)

1. **Install Chrome (Any Recent Version)**
   - Chrome Stable: https://www.google.com/chrome/
   - No special flags required
   - Works on any recent Chrome version

2. **Get a Free API Key**
   - Visit [Google AI Studio](https://aistudio.google.com/api-keys)
   - Sign in with your Google account
   - Click "Create API Key" to generate a new key
   - Copy the API key (starts with "AI...")

### Loading the Extension

1. **Download or Clone the Repository**
   ```bash
   git clone https://github.com/sumit189/LearnTube-AI.git
   cd LearnTube-AI
   ```

2. **Open Extension Management Page**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" using the toggle in the top-right corner

3. **Load the Extension**
   - Click "Load unpacked" button (top-left)
   - Navigate to the `LearnTube-AI` folder and select it
   - The extension should now appear in your extensions list

4. **Pin the Extension** (Optional)
   - Click the puzzle icon in Chrome's toolbar
   - Find "LearnTube AI" and click the pin icon
   - The extension icon will now be visible in your toolbar

### First-Time Setup

#### Option 1: On Device AI (Default - No API Key Required)

1. **Open a YouTube Video**
   - Navigate to any YouTube video with captions/transcript available
   - Educational videos work best (e.g., Khan Academy, Crash Course, MIT OpenCourseWare)

2. **Download AI Models** (if needed)
   - Click the LearnTube AI icon in your toolbar
   - Check the "Model Status" section
   - If models show "Not ready", click the "Download" button for each model
   - Model downloads are ~22GB total and may take several minutes
   - Once downloaded, models are cached permanently

3. **Start Learning**
   - With models ready, reload the YouTube video page
   - The extension will automatically extract the transcript and prepare quizzes
   - Watch the video normally - it will pause automatically when quizzes appear
   - Answer the questions and click "Continue" to resume the video

#### Option 2: Gemini API (Faster Processing)

1. **Get a Free API Key**
   - Visit [Google AI Studio](https://aistudio.google.com/api-keys)
   - Sign in with your Google account
   - Click "Create API Key" to generate a new key
   - Copy the API key (starts with "AI...")

2. **Configure the Extension**
   - Click the LearnTube AI icon in your toolbar
   - Select "Gemini API" as your AI provider
   - Paste your API key in the "Enter API Key" field
   - Click "Save" to store the key locally

3. **Start Learning**
   - Navigate to any YouTube video with captions
   - The extension will use Google's cloud AI for faster processing
   - Quizzes will be generated more quickly with enhanced AI capabilities

### Troubleshooting

**Models won't download**: Make sure you've enabled the flags correctly and restarted Chrome. Some systems may not support on-device AI models due to hardware requirements.

**No transcript available**: The extension requires videos to have captions or transcripts. Auto-generated captions work fine. If a video has no transcript, the extension won't be able to generate quizzes.

**Quizzes not appearing**: Check that the extension is enabled in the popup settings. Also verify that you're on a YouTube video page (not the homepage). Try clearing the cache and reloading the page.

**Extension not loading**: Make sure you're using a recent version of Chrome and have enabled the required flags in `chrome://flags`. Restart Chrome after enabling the flags.

## Popup Controls & Configuration

Open the extension popup (click the icon) to access settings:

- **Select Model Provider**: Choose between "On Device" (Chrome's built-in AI) or "Gemini API" (Google's cloud AI)
- **Enter API Key**: If using Gemini API, enter your free API key from Google AI Studio
- **Enable LearnTube AI**: Master toggle for all in-video quiz features
- **Auto Quiz**: Whether quizzes appear automatically during playback
- **Final Quiz**: Whether to show the comprehensive end-of-video quiz
- **Questions per Segment**: Choose how many questions each mid-video quiz contains (1-3)
- **Theme**: Switch between dark and light popup themes to match your preference
- **Clear This Video**: Remove cached quizzes for the currently open video so they regenerate on reload
- **Clear All Cache**: Wipe cached quizzes and transcripts for every video if you want a clean slate
- **Clear Progress**: Reset aggregated quiz history and statistics displayed in the popup
- **Share Progress**: Copy a shareable summary of your current-video or overall quiz performance to the clipboard

## Privacy

**On Device Mode (Default)**: All data stays on your device. The extension:
- Does not send any data to external servers
- Does not track your viewing history beyond local storage
- Uses Chrome's built-in AI models that run entirely offline
- Stores quiz progress locally using Chrome's Storage API

**Gemini API Mode**: When using Google's Gemini API:
- Video transcripts are sent to Google's servers for AI processing
- Your API key is stored locally and never shared
- Quiz progress and answers remain on your device
- No personal data is collected beyond what's necessary for AI processing

You can clear all stored data at any time using the "Clear Progress" button in the popup.

### Optional Analytics

If you leave the **Analytics** toggle enabled in the popup, LearnTube AI forwards a small set of usage metrics to Google Analytics through a proxy endpoint. The payload includes:
- A random client identifier stored in `chrome.storage.local` (no Google account or device identifiers)
- The event name (`user_install`, `user_update`, `analytics_opt_in`, `analytics_opt_out`, `extension_active`, `quiz_progress_snapshot`)
- Lightweight event parameters such as `quiz_type` (`segment` or `final`), `question_count`, `source` (`extension_install`, `extension_update`, `popup_toggle`), and daily cadence flags
- AI provider tracking (`ai_provider`: `on-device` or `gemini-api`) for understanding user preferences
- Automatic Measurement Protocol fields added by the proxy (`app_platform`, `hit_sequence`, `engagement_time_msec`)
- An anonymized SHA-256 hash of the YouTube video ID (`video_id_hash`) when quiz generation events are buffered.
- All analytics traffic is anonymized; events attach only the random client identifier and omit personal or content payloads.

No transcripts, answers, video IDs, URLs, or personally identifiable information are ever sent. The analytics toggle can be turned off at any time; when disabled, the extension skips all telemetry calls.

#### Analytics Event Reference

- **user_install**
   - Trigger: Extension installed for the first time.
   - Params: `source` (`extension_install`).
- **user_update**
   - Trigger: Extension updated to a new version.
   - Params: `source` (`extension_update`).
- **analytics_opt_in** / **analytics_opt_out**
   - Trigger: User toggles analytics on or off in the popup.
   - Params: `source` (`popup_toggle`).
- **extension_active**
   - Trigger: Once per day while the content script is active on YouTube.
   - Params: `cadence` (`daily`).
- **quiz_progress_snapshot**
   - Trigger: Buffered quiz analytics flush (auto, forced, or immediate).
   - Params:
      - `user_correct_total`: Cumulative correct answers for the user.
      - `user_incorrect_total`: Cumulative incorrect answers for the user.
      - `user_total_answered`: Sum of correct and incorrect answers.
      - `generation_event_count`: Number of quiz generation entries included.
      - `flush_reason`: One of `scheduled`, `forced`.
      - `generation_events`: Array of quiz generation details; each entry contains:
      - `video_id_hash`: SHA-256 hash of the YouTube video identifier associated with the quiz batch.
         - `quiz_type`: `segment` or `final`.
         - `segment_index`: Segment number when applicable, otherwise `null`.
         - `question_count`: Questions generated for that segment or quiz.
         - `status`: `completed` or `error`.
         - `error_message`: Failure reason when `status` is `error`, otherwise empty string.
         - `ai_provider`: AI provider used for quiz generation (`on-device` or `gemini-api`).
         - `recorded_at`: Client-side timestamp in milliseconds since epoch.


## AI Provider Comparison

### On Device AI (Default)

**Benefits:**
- **Stronger privacy**: Transcripts, quiz answers, and progress never leave your browser, so sensitive viewing habits remain confidential.
- **Lower latency**: Running Gemini Nano locally removes round trips to remote servers, keeping quizzes responsive even on slower connections.
- **Consistent offline access**: Once models are downloaded, LearnTube AI continues to work during travel or limited connectivity scenarios.
- **No recurring costs**: There are no metered API calls or tokens to manage, making continuous use of the extension free.
- **Deterministic updates**: Model upgrades happen through Chrome updates and device-side downloads, reducing dependency on third-party service changes.

**Requirements:**
- Chrome with AI flags enabled
- 22GB+ free storage space
- 16GB+ RAM and 4+ CPU cores (or 4GB+ VRAM)
- Windows 10/11, macOS 13+, Linux, or ChromeOS (Chromebook Plus)
- Unmetered internet connection for initial download

*Source: [Chrome Built-in AI Requirements](https://developer.chrome.com/docs/ai/get-started)*

### Gemini API (Cloud)

**Benefits:**
- **Faster processing**: Cloud-based AI typically generates quizzes more quickly
- **More powerful AI**: Access to Google's latest Gemini models with enhanced capabilities
- **No local storage**: No need to download large AI models
- **Always up-to-date**: Automatically uses the latest AI improvements
- **Better performance**: Optimized for cloud processing with higher throughput

**Requirements:**
- Internet connection
- Free Google AI Studio API key
- Data sent to Google's servers for processing

## Technical Stack

- JavaScript (ES6+)
- Chrome Extension Manifest V3
- **On Device AI**: Chrome Built-in AI APIs (Gemini Nano)
  - Language Model (Prompt API) for question generation
  - Summarizer API for condensing full transcripts before final quiz generation
- **Cloud AI**: Google Gemini API
  - REST API calls to Google's Gemini 2.5 Flash Lite model
  - Automatic retry logic with exponential backoff
  - Chunked processing for large transcripts
- Chrome Storage API for local persistence
- YouTube DOM manipulation for transcript extraction

## Browser Compatibility

Currently supports:
- Chrome Stable (version 127+)
- Chrome Canary
- Chrome Dev

Not yet supported:
- Other Chromium browsers (Brave, Edge, etc.) - may work but not tested
- Firefox, Safari - built-in AI APIs are Chrome-specific

## Development

The codebase is organized as follows:

- `manifest.json` - Extension configuration and permissions
- `content.js` - Main logic for transcript processing, quiz generation, and UI injection
- `content.css` - Styles for quiz overlays and seekbar indicators
- `background.js` - Service worker for settings and progress management
- `popup.html/js/css` - Extension popup interface
- `icons/` - Extension icons in various sizes

To modify the extension:
1. Make your changes to the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the LearnTube AI card
4. Reload any open YouTube tabs to see your changes

## License

This project is open source. Feel free to fork, modify, and use it for your own learning or projects.

