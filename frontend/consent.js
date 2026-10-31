// Cookie consent for Google Analytics (Consent Mode v2). Each page sets the
// default consent inline before gtag config; this file only shows the banner
// and records the visitor's choice.
(function () {
  var KEY = 'ln_consent';

  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function save(value) {
    try { localStorage.setItem(KEY, value); } catch (e) {}
  }
  function apply(value) {
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: value });
    }
  }

  var style = document.createElement('style');
  style.textContent =
    '.ln-consent{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;' +
    'max-width:560px;margin:0 auto;background:#161925;color:#e8eaf0;border:1px solid #2b3045;border-radius:14px;' +
    'box-shadow:0 12px 32px rgba(0,0,0,.45);padding:14px 16px;font:14px/1.5 "DM Sans",system-ui,sans-serif;' +
    'display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}' +
    '.ln-consent p{margin:0;flex:1 1 260px;color:#c3c7d6}' +
    '.ln-consent a{color:#a99fff}' +
    '.ln-consent .ln-actions{display:flex;gap:8px;margin-left:auto}' +
    '.ln-consent button{font:600 14px "DM Sans",system-ui,sans-serif;border-radius:10px;padding:9px 16px;cursor:pointer}' +
    '.ln-consent .ln-accept{background:#6a5ae6;color:#fff;border:1px solid #6a5ae6}' +
    '.ln-consent .ln-decline{background:transparent;color:#e8eaf0;border:1px solid #3a4058}' +
    '.ln-consent button:focus-visible{outline:2px solid #a99fff;outline-offset:2px}' +
    '@media print{.ln-consent{display:none!important}}';
  document.head.appendChild(style);

  var banner = null;

  function close() {
    if (banner) { banner.remove(); banner = null; }
  }

  function choose(value) {
    save(value);
    apply(value);
    close();
  }

  function show() {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'ln-consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
      '<p>We use Google Analytics cookies to see how LoanNiti is used and improve it. ' +
      'Your loan numbers are never sent to Google Analytics. <a href="/privacy.html">Privacy policy</a></p>' +
      '<div class="ln-actions">' +
      '<button type="button" class="ln-decline">Decline</button>' +
      '<button type="button" class="ln-accept">Accept</button>' +
      '</div>';
    banner.querySelector('.ln-accept').addEventListener('click', function () { choose('granted'); });
    banner.querySelector('.ln-decline').addEventListener('click', function () { choose('denied'); });
    document.body.appendChild(banner);
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('.ln-consent-open');
    if (link) { e.preventDefault(); show(); }
  });

  if (read() === null) show();
})();
