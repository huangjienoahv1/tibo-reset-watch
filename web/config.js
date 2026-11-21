// Override this file when hosting the browser client next to your own stream worker.
// Keep credentials in the worker; this value is only a public JSON endpoint.
window.TIBO_RESET_WATCH_CONFIG = Object.freeze({
  translationEndpoint: "/api/translate",
  xScreenshotEndpoint: "/api/x-screenshot",
  xScreenshotStatusEndpoint: "/api/x-screenshot-status",
  feedEndpoint: "/api/feed",
});
