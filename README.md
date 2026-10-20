# Nudge

Nudge is a Manifest V3 browser extension that helps turn daily intentions into
focused work sessions. Create tasks, set an estimated duration, and choose
websites to block or allow while you work. Nudge also tracks browsing time and
summarizes focus and website activity.

## Features

- Add daily tasks with an estimated time, priority, category, and tags.
- Run a focus timer for a task, pause or stop a session, and take breaks.
- Choose a per-task blocking mode:
  - **Block distractions**: block the domains you select.
  - **Whitelist only**: allow selected domains and block other sites.
- Manage a default blocklist and review focus history in the calendar.
- View day, week, and month screen-time analytics.
- See contextual nudges while browsing during a focus session.

Task and activity data is stored in the browser using `chrome.storage.local`.

## Install from source

You need Node.js and npm, plus a Chromium-based browser that supports Manifest
V3 extensions.

1. Clone the repository and enter the project directory:

   ```sh
   git clone https://github.com/kaniskgautam/Nudge.git
   cd Nudge
   ```

2. Install dependencies and build the extension:

   ```sh
   npm install
   npm run build
   ```

3. Open `chrome://extensions` in Chrome (or the equivalent extensions page in
   your browser) and enable **Developer mode**.
4. Select **Load unpacked** and choose the generated `dist` folder inside the
   project.
5. Pin Nudge from the browser's extensions menu if you want quick access.

After changing source files, run `npm run build` again. If the extension is
already loaded, reload it on the extensions page to use the updated build.

## Use Nudge

1. Select the Nudge toolbar icon to open the popup.
2. On **Today's intentions**, choose **Add New Task**. Enter what you want to
   work on, set an estimated duration and priority, then choose the blocking
   mode and edit its blocked or allowed domains if needed.
3. Save the task. Select its card to start focusing; the task view shows the
   running timer and focus controls.
4. Use the navigation at the bottom of the popup to open the calendar,
   analytics, or default blocklist.

Nudge's content script runs on web pages so it can display focus nudges and
measure active website time. The extension requests access to all website URLs
to support per-task site blocking and website-usage tracking.

## Development

```sh
npm run dev
```

This builds the extension and watches for source changes. For a one-time
production build, use `npm run build`. The build output is written to `dist/`.
