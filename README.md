# GPT Library Cleaner

A browser extension for managing your ChatGPT Library with full-library sync, type filters, date-based cleanup, bulk selection, ZIP backup, and batch deletion.

## Features

- Full ChatGPT Library synchronization with resumable pagination
- Account-scoped local index
- File-type filtering by extension and MIME type
- Image thumbnails and file-type icons
- Date-based Smart Clean view
- Bulk selection from both File Manager and Smart Clean
- ZIP backup of selected files
- Batched deletion with retry/backoff
- Light and dark themes
- Optional automatic synchronization
- Reopen or hide the Library Cleaner panel from the browser toolbar icon

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Microsoft Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder containing `manifest.json`.
6. Open `https://chatgpt.com/library`.
7. Pin **Library Cleaner** from the browser Extensions menu if you want a permanent toolbar shortcut.

## Notes

- Library Cleaner runs locally in your browser and stores its index in extension storage.
- Index data is separated by ChatGPT account.
- Backup and deletion operate only on the files you explicitly select.
- The floating launcher is not the only way to reopen the tool: clicking the browser toolbar icon toggles the panel as well.
- ChatGPT internal endpoints may change over time; the extension learns the active Library request used by the current page before paginating.

## Version

Current source version: **2.7.0**

## Disclaimer

This is an independent community project and is not an official OpenAI product. Use bulk deletion carefully and keep backups of files you need.
