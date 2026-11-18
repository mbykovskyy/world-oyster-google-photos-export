import { SEL_PREFIX, loadSelection, toCsv } from './shared.js';
import { placeToCoords, placeFor } from './geo.js';

const PHOTOS_ORIGIN = 'https://photos.google.com/';

// ---------- side panel, per tab ----------
// The panel is off by default and turned on only for the tab whose toolbar button
// was clicked. Chrome then shows it in that tab only: switching to another tab hides
// it, switching back shows it again, and each tab you click it in gets its own.
// The tab id is passed to the panel so Export runs in that tab.
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  // No awaits before open(): Chrome only opens a side panel during the click itself.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `panel.html?tab=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// The toolbar button is disabled everywhere except Google Photos tabs whose
// content script has reported a signed-in session.
chrome.action.disable();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'status' && sender.tab) {
    if (msg.loggedIn) chrome.action.enable(sender.tab.id);
    else chrome.action.disable(sender.tab.id);
  } else if (msg?.type === 'placeToCoords') {
    placeToCoords(msg.place).then(sendResponse, () => sendResponse(null));
    return true; // async response
  } else if (msg?.type === 'placeFor') {
    placeFor(msg.lat, msg.lng, msg.googlePlace).then(sendResponse, () => sendResponse(msg.googlePlace ?? null));
    return true;
  } else if (msg?.type === 'csv') {
    // photos.csv content for the export zip: the given photos, oldest first.
    const wanted = new Set(msg.ids);
    loadSelection().then((all) => sendResponse(toCsv(all.filter((r) => wanted.has(r.id)))));
    return true;
  }
});

// Leaving Google Photos in a tab disables the button again. tab.url is only
// visible to us for photos.google.com (host permission), so anything else is undefined.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && !tab.url?.startsWith(PHOTOS_ORIGIN)) {
    chrome.action.disable(tabId);
  }
});

// ---------- badge ----------

async function updateBadge() {
  const records = await loadSelection();
  const missing = records.some((r) => r.status === 'ok' && r.latitude == null);
  await chrome.action.setBadgeBackgroundColor({ color: missing ? '#d93025' : '#1a73e8' });
  await chrome.action.setBadgeText({ text: records.length ? String(records.length) : '' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(SEL_PREFIX))) updateBadge();
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
