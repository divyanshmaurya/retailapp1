'use strict';

/**
 * Shared application shell.
 *
 * Renders the header, the cross-app navigation and the theme toggle so all four
 * screens carry the same chrome, and each page only has to describe the tools
 * that are specific to it. Also holds the handful of helpers every screen ended
 * up needing - formatting, escaping, tooltips, toasts - which were previously
 * copy-pasted between pages and had already started to drift.
 */

const NAV = [
  { href: '/index.html', label: 'Overview', key: 'home' },
  { href: '/command-center/index.html', label: 'Command Centre', key: 'command' },
  { href: '/scenarios/index.html', label: 'Scenarios', key: 'scenarios' },
  { href: '/api/index.html', label: 'API', key: 'api' },
];

const Shell = {
  /**
   * Build the header into the element with id "appHeader".
   * @param {string} active  key of the current page
   * @param {string} toolsHtml  page-specific controls, placed on the right
   */
  header(active, toolsHtml = '') {
    const host = document.getElementById('appHeader');
    if (!host) return;
    host.className = 'app-header';
    host.innerHTML = `
      <a class="brand" href="/index.html" style="text-decoration:none;color:inherit">
        <span class="brand-mark">S</span>
        <span class="brand-text">
          <span class="brand-name">S.Mart Retail AI</span>
          <span class="brand-sub">Autonomous store intelligence</span>
        </span>
      </a>
      <nav class="app-nav">
        ${NAV.map((n) => `<a href="${n.href}"${n.key === active ? ' class="active"' : ''}>${n.label}</a>`).join('')}
      </nav>
      <div class="header-tools">
        ${toolsHtml}
        <button class="btn" id="themeToggle" title="Switch between light and dark"></button>
      </div>`;

    // Remember the choice, and fall back to the operating system setting.
    const stored = localStorage.getItem('smart-theme');
    if (stored) document.documentElement.setAttribute('data-theme', stored);
    Shell.syncThemeLabel();

    document.getElementById('themeToggle').addEventListener('click', () => {
      const isDark = Shell.isDark();
      const next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('smart-theme', next);
      Shell.syncThemeLabel();
      // Charts read their colours from CSS variables when they draw, so they
      // have to be told to redraw rather than relying on the cascade.
      window.dispatchEvent(new CustomEvent('themechange'));
    });
  },

  isDark() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  },

  syncThemeLabel() {
    const button = document.getElementById('themeToggle');
    if (button) button.textContent = Shell.isDark() ? 'Light' : 'Dark';
  },

  // --- formatting --------------------------------------------------------

  euro: (v) => new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(v) || 0),

  euro0: (v) => new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(Number(v) || 0),

  num: (v, d = 0) => new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: d, maximumFractionDigits: d,
  }).format(Number(v) || 0),

  pct: (v) => `${Shell.num(Number(v) * 100, 1)}%`,

  titleCase: (s) => String(s || '').toLowerCase().replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()),

  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),

  /** Single quotes terminate an OData string literal, so they must be doubled. */
  odata: (v) => String(v).replace(/'/g, "''"),

  // --- data --------------------------------------------------------------

  async fetchJson(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      method: options.method || 'GET',
      body: options.body,
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        if (payload?.error?.message) detail = payload.error.message;
      } catch { /* not JSON */ }
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const payload = await response.json();
    return payload.value !== undefined ? payload.value : payload;
  },

  // --- feedback ----------------------------------------------------------

  toast(message) {
    let el = document.getElementById('shellToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shellToast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('on');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('on'), 2800);
  },

  // --- tooltip -----------------------------------------------------------

  _tip: null,

  tipTarget() {
    if (!Shell._tip) {
      const el = document.createElement('div');
      el.className = 'tooltip';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
      Shell._tip = el;
    }
    return Shell._tip;
  },

  /** Attach the standard hover tooltip to an SVG mark or any element. */
  bindTip(element, title, rows) {
    const show = (event) => {
      const tip = Shell.tipTarget();
      tip.innerHTML = `<div class="tt-title">${Shell.esc(title)}</div>`
        + rows.map((r) => `<div class="tt-row">${Shell.esc(r)}</div>`).join('');
      tip.classList.add('on');
      Shell.moveTip(event);
    };
    element.addEventListener('mouseenter', show);
    element.addEventListener('mousemove', Shell.moveTip);
    element.addEventListener('mouseleave', () => Shell.tipTarget().classList.remove('on'));
  },

  moveTip(event) {
    const tip = Shell.tipTarget();
    const pad = 14;
    const box = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  },

  // --- svg ---------------------------------------------------------------

  svg(name, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  },

  /**
   * Rounded rectangle with only the two ends away from the baseline rounded, so
   * bars stay anchored to the axis instead of appearing to float.
   */
  barPath(x, y, width, height, radius, horizontal) {
    const r = Math.max(0, Math.min(radius, horizontal ? width : height, (horizontal ? height : width) / 2));
    if (r <= 0.5) return `M${x},${y}h${width}v${height}h${-width}Z`;
    if (horizontal) {
      return `M${x},${y}h${width - r}a${r},${r} 0 0 1 ${r},${r}v${height - 2 * r}`
        + `a${r},${r} 0 0 1 ${-r},${r}h${-(width - r)}Z`;
    }
    return `M${x},${y + r}a${r},${r} 0 0 1 ${r},${-r}h${width - 2 * r}`
      + `a${r},${r} 0 0 1 ${r},${r}v${height - r}h${-width}Z`;
  },

  niceMax(value) {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const scaled = value / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
  },
};

window.Shell = Shell;
