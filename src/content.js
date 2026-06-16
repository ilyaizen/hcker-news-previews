// content.js — orchestrates: scan stories -> batch fetch -> inject ONE thumbnail
// per story, with hover preview card, click lightbox, hcker.news settings-panel
// controls, and a keyboard shortcut. Runs at document_idle on hcker.news.

(function () {
  const HANDLED_ATTR = 'data-yahnc-thumb'; // marks an injected story container
  // imageSize: 'large' (block above title) | 'xs' (small fixed column beside text)
  const DEFAULT_SETTINGS = { enabled: true, apiBase: '', imageSize: 'large' };

  let settings = { ...DEFAULT_SETTINGS };
  let scanScheduled = false;
  let observer = null;

  // Live coverage counters for the status line.
  const stats = { matched: 0, loaded: 0, apiOk: null };

  // ---------------------------------------------------------------- settings
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch (e) {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  async function setEnabled(value) {
    settings.enabled = value;
    try {
      await chrome.storage.sync.set({ enabled: value });
    } catch (e) {
      /* storage may be unavailable; in-memory state still applies */
    }
    applyEnabledState();
  }

  function applyEnabledState() {
    document.documentElement.classList.toggle('yahnc-disabled', !settings.enabled);
    if (settings.enabled) scheduleScan();
    renderYahncSettings();
  }

  // ---------------------------------------------------------------- thumbnail
  // opts: { large: bool, storyHref: string|null, title: Element|null }
  //  large -> <a> block above title; click opens the story link; hovering it
  //           highlights the title (shared hover group); NO zoom modal/preview.
  //  xs    -> small fixed column thumb; hover preview card; click opens the
  //           zoom lightbox.
  function buildThumb(entry, opts) {
    const large = opts.large;
    const wrap = document.createElement(large ? 'a' : 'span');
    wrap.className = 'yahnc-thumb-wrap ' + (large ? 'yahnc-large' : 'yahnc-xs');
    if (large && opts.storyHref) wrap.href = opts.storyHref;

    // Clipped frame so the 10% zoom (scale 1.1) is cropped to the 16:9 box
    // without overflowing — and without clipping the absolute hover preview,
    // which lives on the wrap, not the frame.
    const frame = document.createElement('span');
    frame.className = 'yahnc-thumb-frame';

    const thumb = document.createElement('img');
    thumb.className = 'yahnc-thumb';
    thumb.src = entry.image_url;
    thumb.alt = entry.title || '';
    thumb.loading = 'lazy';
    if (!large) thumb.title = 'Click to enlarge';

    if (large) {
      // Image is part of the title's hover group: hovering it activates the
      // title, and clicking navigates to the story (native <a> href).
      // Also: hovering the title should zoom the image and underline the title.
      if (opts.title) {
        wrap.addEventListener('mouseenter', () => {
          opts.title.classList.add('yahnc-title-hot');
          wrap.classList.add('yahnc-title-hovered');
        });
        wrap.addEventListener('mouseleave', () => {
          opts.title.classList.remove('yahnc-title-hot');
          wrap.classList.remove('yahnc-title-hovered');
        });
        opts.title.addEventListener('mouseenter', () => {
          opts.title.classList.add('yahnc-title-hot');
          wrap.classList.add('yahnc-title-hovered');
        });
        opts.title.addEventListener('mouseleave', () => {
          opts.title.classList.remove('yahnc-title-hot');
          wrap.classList.remove('yahnc-title-hovered');
        });
      }
    } else {
      // Larger floating preview card on hover (xs only, CSS-driven).
      const preview = document.createElement('span');
      preview.className = 'yahnc-preview';
      const pimg = document.createElement('img');
      pimg.className = 'yahnc-preview-img';
      pimg.src = entry.image_url;
      pimg.alt = '';
      pimg.loading = 'lazy';
      preview.appendChild(pimg);

      // favicon + domain caption (empty span collapses via CSS when no domain).
      const meta = document.createElement('span');
      meta.className = 'yahnc-preview-meta';
      if (entry.domain) {
        if (entry.favicon) {
          const fav = document.createElement('img');
          fav.className = 'yahnc-favicon';
          fav.src = entry.favicon;
          fav.alt = '';
          fav.loading = 'lazy';
          meta.appendChild(fav);
        }
        const dom = document.createElement('span');
        dom.className = 'yahnc-preview-domain';
        dom.textContent = entry.domain;
        meta.appendChild(dom);
      }
      preview.appendChild(meta);
      wrap._preview = preview; // appended after the frame below

      thumb.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openModal(entry);
      });
    }

    // A broken remote og:image (dead URL, non-image content) would otherwise
    // leave the empty gray box — making coverage look worse than it is. Hide the
    // whole thumb instead so only images that actually paint stay on the page.
    thumb.addEventListener('error', () => {
      wrap.style.display = 'none';
    });

    frame.appendChild(thumb);
    wrap.appendChild(frame);
    if (wrap._preview) wrap.appendChild(wrap._preview);
    return wrap;
  }

  // Actual rendered page background (handles HN's own theme toggle, which can
  // disagree with the OS prefers-color-scheme media query and can change live
  // without a reload — so this is recomputed on every call, not cached).
  function pageIsDark() {
    let bg = getComputedStyle(document.body).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
      bg = getComputedStyle(document.documentElement).backgroundColor;
    }
    const m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
    return m
      ? (parseInt(m[1], 10) * 299 + parseInt(m[2], 10) * 587 + parseInt(m[3], 10) * 114) / 1000 < 128
      : false;
  }

  // The favicon before the title, wrapped in an inverse-theme circle badge
  // (mirrors the hn-clone story-favicon treatment).
  function buildFavicon(entry) {
    const badge = document.createElement('span');
    badge.className = 'yahnc-fav-badge';
    badge.style.setProperty('--yahnc-fav-bg', pageIsDark() ? '#f5f5f5' : '#111');
    const fav = document.createElement('img');
    fav.className = 'yahnc-title-favicon';
    fav.src = entry.favicon;
    fav.alt = '';
    fav.loading = 'lazy';
    fav.referrerPolicy = 'no-referrer';
    badge.appendChild(fav);
    return badge;
  }

  // The og/meta description on its own line under the title + url.
  function buildDescription(entry) {
    const desc = document.createElement('div');
    desc.className = 'yahnc-desc';
    desc.textContent = entry.description;
    return desc;
  }

  function injectInto(row, anchor, entry) {
    const title = window.YAHNC.titleAnchor(row, anchor);
    const host = window.YAHNC.titleHost(row, title);
    const large = settings.imageSize !== 'xs';
    const storyHref = title ? title.getAttribute('href') : null;

    const node = buildThumb(entry, { large, storyHref, title });

    // textHost = where favicon/description land. In xs mode the site's own
    // children move into a right-hand text column so the thumb becomes a fixed
    // left column (flex row); in large mode they stay on the host.
    let textHost = host;
    if (large) {
      // Large mode: insert thumb AFTER the description (which is appended to textHost)
      // We'll insert it after textHost's content, effectively at the end of host
      // Favicon immediately before the title text (inline, in the title's line).
      if (entry.favicon && title && title.parentElement) {
        title.parentElement.insertBefore(buildFavicon(entry), title);
      }

      // Description as a new line after the title/url.
      if (entry.description) {
        textHost.appendChild(buildDescription(entry));
      }

      // Image goes after description (at end of host)
      host.appendChild(node);
    } else {
      host.classList.add('yahnc-xs-host');
      const text = document.createElement('div');
      text.className = 'yahnc-xs-text';
      while (host.firstChild) text.appendChild(host.firstChild);
      // XS mode: image must be FIRST child for flex layout (left column)
      host.appendChild(node);
      host.appendChild(text);
      textHost = text;

      // Favicon immediately before the title text (inline, in the title's line).
      if (entry.favicon && title && title.parentElement) {
        title.parentElement.insertBefore(buildFavicon(entry), title);
      }

      // Description as a new line after the title/url.
      if (entry.description) {
        textHost.appendChild(buildDescription(entry));
      }
    }
  }

  // Reverse injectInto for a row: remove our nodes and unwrap the xs text
  // column, restoring the site's original DOM so a re-scan injects cleanly in
  // whatever mode is now active.
  function removeInjections(row) {
    row.querySelectorAll('.yahnc-thumb-wrap, .yahnc-fav-badge, .yahnc-desc').forEach((n) => n.remove());
    row.querySelectorAll('.yahnc-title-hot').forEach((n) => n.classList.remove('yahnc-title-hot'));
    const host = row.querySelector('.yahnc-xs-host');
    if (host) {
      const text = host.querySelector('.yahnc-xs-text');
      if (text) {
        while (text.firstChild) host.appendChild(text.firstChild);
        text.remove();
      }
      host.classList.remove('yahnc-xs-host');
    }
    row.removeAttribute(HANDLED_ATTR);
  }

  // Tear down every injected story and re-scan in the current settings.
  function reapplyInjections() {
    document.querySelectorAll('[' + HANDLED_ATTR + ']').forEach(removeInjections);
    stats.matched = 0;
    stats.loaded = 0;
    scheduleScan();
  }

  async function setSize(value) {
    if (settings.imageSize === value) return;
    settings.imageSize = value;
    try {
      await chrome.storage.sync.set({ imageSize: value });
    } catch (e) {
      /* storage may be unavailable; in-memory state still applies */
    }
    reapplyInjections();
    renderYahncSettings();
  }

  // ---------------------------------------------------------------- lightbox
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.5;
  let modalEl = null;
  let zoom = 1;

  function applyZoom() {
    if (!modalEl) return;
    modalEl.querySelector('.yahnc-modal-img').style.setProperty('--yahnc-zoom', String(zoom));
  }

  function setZoom(next) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    applyZoom();
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'yahnc-modal';
    modalEl.innerHTML =
      '<div class="yahnc-modal-card" role="dialog" aria-modal="true" aria-label="Story image">' +
      '<div class="yahnc-modal-stage"><img class="yahnc-modal-img" alt="" /></div>' +
      '<div class="yahnc-modal-bar">' +
      '<img class="yahnc-favicon yahnc-modal-favicon" alt="" />' +
      '<span class="yahnc-modal-text">' +
      '<span class="yahnc-modal-title"></span>' +
      '<span class="yahnc-modal-desc"></span>' +
      '</span>' +
      '<span class="yahnc-modal-zoom">' +
      '<button type="button" class="yahnc-zoom-btn" data-zoom="out" aria-label="Zoom out">−</button>' +
      '<button type="button" class="yahnc-zoom-btn" data-zoom="reset" aria-label="Reset zoom">↻</button>' +
      '<button type="button" class="yahnc-zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>' +
      '</span>' +
      '</div></div>';
    modalEl.addEventListener('click', (ev) => {
      if (ev.target === modalEl) closeModal();
    });
    modalEl.querySelectorAll('.yahnc-zoom-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-zoom');
        if (action === 'in') setZoom(zoom + ZOOM_STEP);
        else if (action === 'out') setZoom(zoom - ZOOM_STEP);
        else setZoom(1);
      });
    });
    document.body.appendChild(modalEl);
    return modalEl;
  }

  function openModal(entry) {
    const el = ensureModal();
    el.querySelector('.yahnc-modal-img').src = entry.image_url;
    el.querySelector('.yahnc-modal-title').textContent = entry.title || '';
    el.querySelector('.yahnc-modal-desc').textContent = entry.description || '';

    const fav = el.querySelector('.yahnc-modal-favicon');
    if (entry.favicon) {
      fav.src = entry.favicon;
      fav.alt = entry.domain || '';
      fav.style.display = '';
    } else {
      fav.removeAttribute('src');
      fav.style.display = 'none';
    }

    setZoom(1); // each open starts at 1:1
    el.classList.add('yahnc-open');
  }

  function closeModal() {
    if (modalEl) modalEl.classList.remove('yahnc-open');
  }

  // ------------------------------------------------ hcker.news settings panel
  // Injected as another category INSIDE hcker.news's existing settings tab
  // (not a separate top-level tab) — appended to the first tab panel found.
  let yahncSectionEl = null;
  let settingsRenderScheduled = false;

  function findSettingsPanel() {
    return document.querySelector('#settings-panel, .settings-panel');
  }

  function buildYahncSection() {
    const section = document.createElement('section');
    section.id = 'yahnc-previews-settings-section';
    section.className = 'settings-section yahnc-settings-section';
    section.innerHTML =
      '<h3 class="settings-section-title">YAHNC Previews</h3>' +
      '<div class="settings-section-content">' +
      '<div class="settings-row">' +
      '<label class="settings-label" for="yahnc-enabled">Show story previews</label>' +
      '<div class="settings-options"><label class="toggle-switch"><input type="checkbox" id="yahnc-enabled"><span class="toggle-slider"></span></label></div>' +
      '</div>' +
      '<div class="settings-row">' +
      '<span class="settings-label">Preview size</span>' +
      '<div class="settings-options yahnc-size-options">' +
      '<button type="button" class="settings-option yahnc-size-option" data-yahnc-size="large">Large</button>' +
      '<button type="button" class="settings-option yahnc-size-option" data-yahnc-size="xs">XS</button>' +
      '</div>' +
      '</div>' +
      '<div class="settings-row yahnc-status-row"><span class="settings-label">Status</span><div class="settings-options"><span class="yahnc-settings-status"></span></div></div>' +
      '</div>';

    section.querySelector('#yahnc-enabled').addEventListener('change', (ev) => setEnabled(ev.target.checked));
    section.querySelectorAll('.yahnc-size-option').forEach((button) => {
      button.addEventListener('click', () => setSize(button.getAttribute('data-yahnc-size')));
    });

    return section;
  }

  function ensureYahncSettingsPanel() {
    const settingsPanel = findSettingsPanel();
    if (!settingsPanel) return false;

    yahncSectionEl = settingsPanel.querySelector('#yahnc-previews-settings-section');
    if (!yahncSectionEl) {
      const targetPanel = settingsPanel.querySelector('.settings-tab-panel') || settingsPanel;
      const wrapper = targetPanel.querySelector('.settings-sections-wrapper') || targetPanel;
      yahncSectionEl = buildYahncSection();
      wrapper.appendChild(yahncSectionEl);
    }

    return true;
  }

  function renderYahncSettings() {
    if (!ensureYahncSettingsPanel()) return;
    const yahncPanelEl = yahncSectionEl;

    const enabled = yahncPanelEl.querySelector('#yahnc-enabled');
    if (enabled.checked !== settings.enabled) enabled.checked = settings.enabled;

    yahncPanelEl.querySelectorAll('.yahnc-size-option').forEach((button) => {
      const active = button.getAttribute('data-yahnc-size') === settings.imageSize;
      button.classList.toggle('is-active', active);
      if (button.getAttribute('aria-pressed') !== String(active)) {
        button.setAttribute('aria-pressed', String(active));
      }
    });

    const apiState = stats.apiOk === null ? 'waiting' : stats.apiOk ? 'API ok' : 'API error';
    const status = settings.enabled
      ? `${stats.loaded}/${stats.matched} loaded · ${apiState} · ${settings.imageSize}`
      : 'disabled · press I to toggle';
    const statusEl = yahncPanelEl.querySelector('.yahnc-settings-status');
    if (statusEl.textContent !== status) statusEl.textContent = status;
  }

  function scheduleSettingsRender() {
    if (settingsRenderScheduled) return;
    settingsRenderScheduled = true;
    setTimeout(() => {
      settingsRenderScheduled = false;
      renderYahncSettings();
    }, 250);
  }

  // ---------------------------------------------------------------- scanning
  async function scan() {
    scanScheduled = false;
    if (!settings.enabled) return;

    const rows = window.YAHNC.findRows(document).filter((r) => !r.row.hasAttribute(HANDLED_ATTR));
    if (rows.length === 0) return;

    // Mark immediately so a concurrent mutation scan does not double-inject.
    rows.forEach((r) => r.row.setAttribute(HANDLED_ATTR, '1'));
    stats.matched += rows.length;

    const ids = [...new Set(rows.map((r) => r.id))];
    const images = await window.YAHNC.fetchImages(ids, settings);
    stats.apiOk = window.YAHNC.apiOk;

    let injected = 0;
    rows.forEach((r) => {
      const entry = images.get(r.id);
      if (entry) {
        injectInto(r.row, r.anchor, entry);
        stats.loaded += 1;
        injected += 1;
      }
    });

    // Hard network failure with nothing resolved: let these rows retry later.
    if (stats.apiOk === false && injected === 0) {
      rows.forEach((r) => r.row.removeAttribute(HANDLED_ATTR));
      stats.matched -= rows.length;
    }
    renderYahncSettings();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(scan, 150); // debounce bursts of mutations
  }

  function onMutation() {
    scheduleScan();
    if (!yahncSectionEl || !document.documentElement.contains(yahncSectionEl)) {
      yahncSectionEl = null;
      scheduleSettingsRender();
    }
  }

  // ---------------------------------------------------------------- keyboard
  function onKeydown(ev) {
    if (ev.key === 'Escape' && modalEl && modalEl.classList.contains('yahnc-open')) {
      closeModal();
      return;
    }
    // Ignore shortcut while typing in hcker.news search/inputs.
    const t = ev.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!typing && (ev.key === 'i' || ev.key === 'I') && !ev.metaKey && !ev.ctrlKey) {
      setEnabled(!settings.enabled);
    }
  }

  // ---------------------------------------------------------------- init
  async function init() {
    await loadSettings();
    applyEnabledState();
    scheduleSettingsRender();
    if (settings.enabled) scan();

    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('keydown', onKeydown, true);

    // React to live option changes without a page reload.
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        loadSettings().then(() => {
          applyEnabledState();
          if (changes.imageSize) reapplyInjections();
        });
      });
    }
  }

  init();
})();
