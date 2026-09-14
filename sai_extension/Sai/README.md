# JobBidHelper

Browser extension to paste job descriptions into Agency Hub and auto-fill applications using AI (Groq).

## Features

- **JD → Platform**: Select the job description on the posting tab and press **1** then **2**. The extension copies it, pastes it into the platform tab on the left, and clicks **Generate resume** — you stay on the job tab
- **Job dock**: On a paired job tab, a right-side **JBH** tab can mark applied, download the resume, chat with the platform assistant, and auto-open the next job
- **Select & Fill**: Select a question label and press **1** then **3** to auto-fill with Groq
- **Platform assistant**: Select a question and press **1** then **4** to ask the Agency Hub assistant, then fill the field
- **Multiple Input Types**: Supports text, email, textarea, select, checkbox, and radio buttons
- **Clipboard**: Groq answers are always copied to the clipboard; fields are filled when detected
- **Field Binding**: Shift+Click to explicitly bind a label to a specific input field
- **Configurable Prompts**: Customize the system prompt for AI responses

## Installation (Unpacked/Developer Mode)

1. Open **Chrome** or **Edge**
2. Go to `chrome://extensions/` (or `edge://extensions/`)
3. Enable **Developer mode** (toggle switch in top right corner)
4. Click **"Load unpacked"** button (top left area)
5. Select the entire `JobBidHelper3` **folder** (not just the files)
6. The extension should appear with a purple icon

## Configuration

### Groq API Key

1. Get an API key from [console.groq.com](https://console.groq.com/keys)
2. Click the extension icon in your browser toolbar
3. Enter your API key
4. Click Save

## Usage

### Tab order (required for JD paste and auto-advance)

Keep this opening order in the same window:

0. Agency Hub **job list** page (pinned at the **first** tab)
1. Agency Hub **apply** page for a job
2. That job's **posting** page
3. Next apply page, then that posting, and so on

The platform tab must sit immediately **left** of its job tab.

### Shortcuts

| Shortcut | Action |
|----------|--------|
| **1** then **2** | Copy selected JD, paste into the platform tab on the left, click Generate resume |
| **1** then **3** | Groq auto-fill for the selected question label |
| **1** then **4** | Send selected question to the platform Application assistant, then fill the field |

Press **1**, then the second key within 1.5 seconds.

### Paste JD and generate resume

1. On the job posting tab, **select the job description**
2. Press **1** then **2**
3. The JD is copied to the clipboard
4. The extension fills **Job description** on the platform tab to the left and clicks **Generate resume**. You stay on the job tab.

The left tab must be the matching apply page. There is no length check — **1** then **2** always treats the selection as a JD.

### Job page dock

When the tab to the left is an Agency Hub apply page, a small **JBH** tab appears on the right edge of the job posting. Hover to expand:

- **Mark applied** — clicks **Mark as applied** on the platform tab, opens the **next** job’s platform + posting tabs (platform left, job right), switches to the new job tab immediately, then closes the finished pair after 3 seconds
- **Download resume** — clicks **Save for …** on the platform tab. If the resume is not ready yet, you get a toast

### Auto-advance to the next job (Mark applied)

1. Pin the Agency Hub **job list** tab (preferably first / index **0**).
2. The extension finds the **highlighted** row (`ring-primary`) or, if none, the **last Applied** (emerald) row.
3. When you finish a job, click **Mark applied** in the JBH dock.
4. After a short pause it **clicks** the next job’s **Resume** and **Open** links on the list (for row styles), then **immediately opens** both tabs via the extension and switches to the new job tab.
5. After **3 seconds** it closes the finished platform + job tabs.

### Platform assistant (1 then 4)

1. Select a question label on the job form
2. Press **1** then **4**
3. The extension copies the question, pastes it into the Application assistant on the platform tab, and clicks send — you stay on the job tab
4. After **6 seconds**, it checks whether **Copy answer** appeared on the latest assistant message. If not, it checks again every **2 seconds** (**10 checks total**). Timing runs in the background so the wait is reliable.
5. When the button is there, it copies the answer to the clipboard (and fills the question field when one is found)

Use the **Assistant** chat in the JBH dock to refine an answer (e.g. “shorter”). The reply stays in the chat instead of filling a form field.

### Auto-Fill

1. Navigate to a job application form
2. **Select text** from a field's label (e.g., "Email Address")
3. Press **1** then **3**
4. AI answer is always copied to the clipboard
5. If an input field is found → it is filled automatically as well

### Explicit Binding (For Ambiguous Forms)

Some forms have multiple similar labels or the proximity detection doesn't work. Use binding mode:

1. **Shift+Click** on a label
2. Click on the **target input field** you want to bind
3. Now selecting that label and pressing **1** then **3** will fill the bound field

### Supported Input Types

| Type | Behavior |
|------|----------|
| Text/Email/Textarea | Fills with AI text response |
| Select | Finds best matching option |
| Checkbox | AI responds yes/no → checked/unchecked |
| Radio | AI picks best matching option |

## Troubleshooting

**JD did not paste to the platform:**
- Confirm tab order: apply page immediately left of the job posting
- Press **1** then **2** (not 1 then 3)
- Reload the extension after this update (`chrome://extensions` → Reload)

**AI not responding:**
- Verify your Groq API key is valid
- Check your internet connection
- Groq fill uses `openai/gpt-oss-20b` (Llama 3.1 8B Instant was retired on Groq)

**Wrong field filled:**
- Use Shift+Click to explicitly bind the label to the correct input

**No input found:**
- The AI answer is still copied to the clipboard
- Use Shift+Click to bind the label to the correct input

## Files

```
JobBidHelper3/
├── manifest.json     # Extension manifest
├── background.js     # Service worker (JD tab handoff + Groq API)
├── content.js        # Content script (DOM interaction)
├── popup.html        # Settings UI
├── popup.css         # Popup styles
├── popup.js          # Popup logic
├── styles.css        # Injected page styles
├── icons/            # Extension icons
└── README.md         # This file
```

## License

MIT
