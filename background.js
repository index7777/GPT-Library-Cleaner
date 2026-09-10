chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith('https://chatgpt.com/')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'LC_TOGGLE_PANEL' });
  } catch {
    // The content script may not be ready on this tab yet.
  }
});
