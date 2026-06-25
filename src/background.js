// PullDown QR — service worker
// Seeds defaults, mirrors the enabled state onto the toolbar badge, and handles
// the keyboard shortcut for toggling on/off.
importScripts('defaults.js');

const DEFAULTS = globalThis.PDQR_DEFAULTS;

function setBadge(enabled) {
  try {
    chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
    chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  } catch (e) { /* ignore */ }
}

function refreshBadge() {
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, (s) => setBadge(s.enabled));
}

chrome.runtime.onInstalled.addListener(() => {
  // Fill in any missing keys without clobbering user-set values.
  chrome.storage.sync.get(DEFAULTS, (current) => {
    chrome.storage.sync.set(current, refreshBadge);
  });
});

chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) setBadge(changes.enabled.newValue);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-enabled') return;
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, (s) => {
    chrome.storage.sync.set({ enabled: !s.enabled });
  });
});
