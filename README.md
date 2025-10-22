# LearnTube AI

A Chrome extension that transforms passive YouTube watching into active learning by generating AI-powered quizzes during videos. Think of it like Coursera's quiz system, but automatically applied to any educational YouTube video you watch.

## What It Is

LearnTube AI is a Chrome extension that uses Chrome's built-in Gemini Nano AI (no external API keys required) to analyze video transcripts and generate contextual quiz questions. The extension pauses videos at natural topic transitions to quiz you on what you just learned, then gives you a comprehensive final quiz when the video ends.

All AI processing happens locally on your machine using Chrome's built-in AI APIs. No data leaves your browser, and it works offline once the models are downloaded.

## How It Works

### Architecture

The extension consists of three main components working together:

**Content Script** (`content.js`)
- Injects into YouTube video pages
- Extracts and processes video transcripts by clicking the transcript button and parsing the panel
- Segments transcripts into logical chunks (default 180 seconds each)
- Monitors video playback using `timeupdate` events to trigger quizzes at the right moments
- Generates quiz questions using Chrome's AI APIs
- Displays quiz overlays on top of the video player

**Background Script** (`background.js`)
- Manages extension settings and user progress in Chrome's local storage
- Handles messages between popup and content scripts
- Initializes default settings when extension is installed

**Popup UI** (`popup.html`, `popup.js`)
- Provides controls for enabling/disabling features
- Shows model status and allows downloading AI models if not available
- Displays user statistics (videos watched, quizzes taken, average score) and lets you share progress for the current video or overall history
- Offers cache management tools to refresh quizzes for the current video or wipe all cached data
- Includes theme selection and other preferences that sync with the in-video experience

### Key Implementation Details

**AI Model Management**: The extension checks if Chrome's Language Model and Summarizer are available using `LanguageModel.availability()` and `Summarizer.availability()`. If not downloaded (status is "downloadable"), users can trigger the download via the popup interface which creates a session with the model to initiate the download.

**Quiz Generation**: For mid-video quizzes, questions are generated using the Language Model (Prompt API) with a system prompt that instructs the AI to create multiple-choice questions with 4 options and explanations. For the final quiz, the entire transcript is first summarized using the Summarizer API to extract key points, then the Language Model generates questions based on that summary. This approach improves performance and focuses the final quiz on the most important concepts.

**Caching**: Generated quizzes are stored in Chrome's local storage under the video ID to avoid regenerating them on subsequent views. Users can clear the cache via the popup if they want fresh questions.

**Seekbar Indicators**: Small green dots appear on the YouTube seekbar showing where quizzes will appear. These are dynamically injected as absolutely positioned divs that update as the seekbar resizes.

**Overlay UI**: Quiz overlays are created as custom HTML elements injected into the page with high z-index values to appear above the video player. They include the question, answer options, feedback, and navigation controls.

## Installation (Unpacked Extension)

Since this extension uses Chrome's built-in AI APIs, you need a recent version of Chrome with specific flags enabled.

### Prerequisites

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

1. **Open a YouTube Video**
   - Navigate to any YouTube video with captions/transcript available
   - Educational videos work best (e.g., Khan Academy, Crash Course, MIT OpenCourseWare)

2. **Download AI Models** (if needed)
   - Click the LearnTube AI icon in your toolbar
   - Check the "Model Status" section
   - If models show "Not ready", click the "Download" button for each model
   - Model downloads are ~1.5GB total and may take several minutes
   - Once downloaded, models are cached permanently

3. **Start Learning**
   - With models ready, reload the YouTube video page
   - The extension will automatically extract the transcript and prepare quizzes
   - Watch the video normally - it will pause automatically when quizzes appear
   - Answer the questions and click "Continue" to resume the video

### Troubleshooting

**Models won't download**: Make sure you've enabled the flags correctly and restarted Chrome. Some systems may not support on-device AI models due to hardware requirements.

**No transcript available**: The extension requires videos to have captions or transcripts. Auto-generated captions work fine. If a video has no transcript, the extension won't be able to generate quizzes.

**Quizzes not appearing**: Check that the extension is enabled in the popup settings. Also verify that you're on a YouTube video page (not the homepage). Try clearing the cache and reloading the page.

**Extension not loading**: Make sure you're using a recent version of Chrome and have enabled the required flags in `chrome://flags`. Restart Chrome after enabling the flags.

## Popup Controls & Configuration

Open the extension popup (click the icon) to access settings:

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

All data stays on your device. The extension:
- Does not send any data to external servers
- Does not track your viewing history beyond local storage
- Uses Chrome's built-in AI models that run entirely offline
- Stores quiz progress locally using Chrome's Storage API

You can clear all stored data at any time using the "Clear Progress" button in the popup.

## Technical Stack

- JavaScript (ES6+)
- Chrome Extension Manifest V3
- Chrome Built-in AI APIs (Gemini Nano)
  - Language Model (Prompt API) for question generation
  - Summarizer API for condensing full transcripts before final quiz generation
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

