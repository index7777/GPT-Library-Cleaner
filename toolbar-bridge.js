(() => {
  const hostId = 'lc-extension-host';

  const getUi = () => {
    const host = document.getElementById(hostId);
    const root = host?.shadowRoot;
    if (!root) return null;
    return {
      root,
      panel: root.getElementById('lc-panel'),
      launcher: root.getElementById('lc-launcher'),
      close: root.getElementById('lc-close'),
      version: root.querySelector('.lc-version-badge')
    };
  };

  const syncVersion = () => {
    const ui = getUi();
    if (!ui?.version) return false;
    const version = chrome.runtime.getManifest().version;
    ui.version.textContent = `v${version.replace(/\.0$/, '')}`;
    return true;
  };

  const timer = setInterval(() => {
    if (syncVersion()) clearInterval(timer);
  }, 250);
  setTimeout(() => clearInterval(timer), 10000);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'LC_TOGGLE_PANEL') return;
    const ui = getUi();
    if (!ui?.panel || !ui.launcher || !ui.close) {
      sendResponse?.({ ok: false, reason: 'not-ready' });
      return;
    }
    const isOpen = ui.panel.classList.contains('is-open');
    (isOpen ? ui.close : ui.launcher).click();
    syncVersion();
    sendResponse?.({ ok: true, open: !isOpen });
  });
})();
