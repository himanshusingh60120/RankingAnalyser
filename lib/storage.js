// lib/storage.js
// Talks to the Google Apps Script web app (apps-script/Code.gs) that saves briefs to Google Drive
// and logs them in the tracking Google Sheet. The script runs as your Google account, which is
// what lets it write — Google's APIs need a signed-in identity even for "anyone can edit" files.
//
// Env: STORAGE_WEBAPP_URL (the Apps Script /exec URL) · STORAGE_SECRET (shown by the script's setup)

export function storageConfigured() {
  return !!(process.env.STORAGE_WEBAPP_URL && process.env.STORAGE_SECRET);
}

export async function callStorage(action, payload = {}, timeoutMs = 45000) {
  if (!storageConfigured()) {
    return { error: "Saving isn't set up yet. Add STORAGE_WEBAPP_URL and STORAGE_SECRET in Vercel, then redeploy." };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(process.env.STORAGE_WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, action, secret: process.env.STORAGE_SECRET }),
      redirect: "follow", // Apps Script answers with a redirect to the result
      signal: ctrl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {
        error: `Google Apps Script didn't return data (HTTP ${res.status}). Check the web app is deployed with access set to "Anyone".`,
        detail: text.slice(0, 200),
      };
    }
  } catch (e) {
    return { error: e.name === "AbortError" ? "Saving to Google Drive timed out." : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
