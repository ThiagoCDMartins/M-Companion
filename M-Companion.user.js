// ==UserScript==
// @name         M+ Companion
// @namespace    https://raider.io/
// @version      1.3.10
// @description  Displays a card comparing the character's M+ score to the current season's cutoffs.
// @author       Upside
// @match        https://raider.io/*
// @icon         https://raider.io/favicon.ico
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/ThiagoCDMartins/M-Companion
// @supportURL   https://github.com/ThiagoCDMartins/M-Companion/issues
// @downloadURL  https://raw.githubusercontent.com/ThiagoCDMartins/M-Companion/main/M-Companion.user.js
// @updateURL    https://raw.githubusercontent.com/ThiagoCDMartins/M-Companion/main/M-Companion.user.js
// @license MIT
// ==/UserScript==

(function () {
  'use strict';

  const SEASON = 'season-mn-1';
  const WIDGET_ID = 'rio-cutoff-compare-widget';
  const CUTOFF_CACHE_MS = 30 * 60 * 1000;
  const PROFILE_CACHE_MS = 2 * 60 * 1000;
  const RENDER_DEBOUNCE_MS = 150;
  const READY_TIMEOUT_MS = 5000;
  const TIER_STORAGE_KEY = 'rio_cc_selected_tier';
  const DISPLAY_MODE_STORAGE_KEY = 'rio_cc_display_mode';

  const TIERS = [
    { key: 'p999', label: 'Top 0.1%', color: '#f46e52', icon: '👑' },
    { key: 'p990', label: 'Top 1%', color: '#df5693', icon: '🥇' },
    { key: 'p900', label: 'Top 10%', color: '#8e4aea', icon: '🏆' },
  ];

  const PROGRESSION_ORDER = ['p900', 'p990', 'p999'];

  const CLASS_COLORS = {
    'Death Knight': '#C41F3B',
    'Demon Hunter': '#A330C9',
    'Druid': '#FF7D0A',
    'Evoker': '#33937F',
    'Hunter': '#AAD372',
    'Mage': '#3FC7EB',
    'Monk': '#00FF98',
    'Paladin': '#F48CBA',
    'Priest': '#F0EBE0',
    'Rogue': '#FFF468',
    'Shaman': '#0070DD',
    'Warlock': '#8788EE',
    'Warrior': '#C69B6D',
  };

  const FACTION_INFO = {
    horde: {
      label: 'Horde',
      color: '#e2504a',
      banner: 'https://cdn.raiderio.net/images/profile/masthead_backdrops/v2/hordebanner1.jpg',
    },
    alliance: {
      label: 'Alliance',
      color: '#4a90e2',
      banner: 'https://cdn.raiderio.net/images/profile/masthead_backdrops/v2/alliancebanner1.jpg',
    },
  };

  const state = {
    selectedTierKey: null,
    lastCharacter: null,
    lastCutoffsData: null,
    currentKey: null,
    renderingKey: null,
    renderRequestId: 0,
    renderController: null,
    renderTimer: null,
    pendingForceRender: false,
    readyPromise: null,
    displayMode: 'embedded',
  };

  try {
    state.selectedTierKey = localStorage.getItem(TIER_STORAGE_KEY) || null;
  } catch {}
  try {
    const savedDisplayMode = localStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
    if (savedDisplayMode === 'embedded' || savedDisplayMode === 'floating') state.displayMode = savedDisplayMode;
  } catch {}

  const style = document.createElement('style');
  style.textContent = `
    #${WIDGET_ID} {
      position: fixed;
      right: 8px;
      bottom: 16px;
      z-index: 2147483647 !important;
      width: 350px;
      max-width: calc(100vw - 16px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e7e7ee;
      background: #171821;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      overflow: hidden;
      pointer-events: auto !important;
      isolation: isolate;
    }
    #${WIDGET_ID} * { box-sizing: border-box; }
    #${WIDGET_ID} .rio-cc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      cursor: pointer;
      user-select: none;
    }
    #${WIDGET_ID} .rio-cc-title {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #9a9aab;
      font-weight: 600;
    }
    #${WIDGET_ID} .rio-cc-controls { display: flex; align-items: center; gap: 8px; }
    #${WIDGET_ID} .rio-cc-btn {
      background: transparent;
      border: none;
      color: #9a9aab;
      font-size: 14px;
      cursor: pointer;
      line-height: 1;
      min-width: 32px;
      min-height: 32px;
      padding: 6px 8px;
    }
    #${WIDGET_ID} .rio-cc-btn:hover { color: #fff; }
    #${WIDGET_ID} .rio-cc-mini-score { display: none; }
    #${WIDGET_ID} .rio-cc-body { padding: 14px; }
    #${WIDGET_ID}.rio-cc-collapsed .rio-cc-body { display: none; }
    #${WIDGET_ID}.rio-cc-collapsed .rio-cc-charhead-slot { display: none; }
    #${WIDGET_ID}.rio-cc-collapsed {
      width: 190px;
      min-width: 0;
      max-width: calc(100vw - 16px);
    }
    #${WIDGET_ID}.rio-cc-collapsed .rio-cc-header { gap: 10px; min-height: 48px; padding: 8px 8px 8px 14px; }
    #${WIDGET_ID}.rio-cc-collapsed .rio-cc-title { font-size: 0; }
    #${WIDGET_ID}.rio-cc-collapsed .rio-cc-title::before { content: 'M+'; font-size: 12px; }
    #${WIDGET_ID}.rio-cc-collapsed .rio-cc-mini-score {
      display: block;
      margin-left: auto;
      font-size: 17px;
      font-weight: 700;
    }
    #${WIDGET_ID}.rio-cc-collapsed [data-refresh] { display: none; }
    @media (max-width: 180px) {
      #${WIDGET_ID}.rio-cc-collapsed .rio-cc-mini-score { display: none; }
    }
    #${WIDGET_ID} .rio-cc-charhead {
      position: relative;
      padding: 12px 14px;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      background-color: rgba(255,255,255,0.03);
    }
    #${WIDGET_ID} .rio-cc-charhead::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(100deg, rgba(15,16,22,0.9), rgba(15,16,22,0.6) 55%, rgba(15,16,22,0.35));
    }
    #${WIDGET_ID} .rio-cc-charhead-content {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    #${WIDGET_ID} .rio-cc-charhead-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    #${WIDGET_ID} .rio-cc-avatar { position: relative; width: 44px; height: 44px; flex-shrink: 0; }
    #${WIDGET_ID} .rio-cc-avatar-fallback {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      color: #d6d6e2;
    }
    #${WIDGET_ID} .rio-cc-avatar img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
    }
    #${WIDGET_ID} .rio-cc-charhead-info { min-width: 0; }
    #${WIDGET_ID} .rio-cc-charhead-name {
      font-size: 15px;
      font-weight: 700;
      text-decoration: none;
      color: inherit;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }
    #${WIDGET_ID} .rio-cc-charhead-name:hover { text-decoration: underline; }
    #${WIDGET_ID} .rio-cc-charhead-meta {
      font-size: 10.5px;
      color: #b7b7c6;
      margin-top: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${WIDGET_ID} .rio-cc-charhead-meta a { color: inherit; text-decoration: none; }
    #${WIDGET_ID} .rio-cc-charhead-meta a:hover { text-decoration: underline; }
    #${WIDGET_ID} .rio-cc-charhead-class { font-size: 10.5px; margin-top: 1px; }
    #${WIDGET_ID} .rio-cc-charhead-score { text-align: right; flex-shrink: 0; }
    #${WIDGET_ID} .rio-cc-charhead-score-label {
      font-size: 9px;
      color: #c7c7d6;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    #${WIDGET_ID} .rio-cc-charhead-score-value { font-size: 20px; font-weight: 700; }
    #${WIDGET_ID} .rio-cc-lower { margin-bottom: 12px; }
    #${WIDGET_ID} .rio-cc-compare-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 5px;
    }
    #${WIDGET_ID} .rio-cc-compare-label { color: #b7b7c6; }
    #${WIDGET_ID} .rio-cc-compare-muted { color: #8b8b9c; }
    #${WIDGET_ID} .rio-cc-compare-diff { font-weight: 700; }
    #${WIDGET_ID} .rio-cc-tier {
      background: rgba(255,255,255,0.03);
      border-radius: 10px;
      padding: 8px 10px;
      margin-bottom: 8px;
      border: 2px solid transparent;
      cursor: pointer;
      transition: border-color .15s ease, background .15s ease;
    }
    #${WIDGET_ID} .rio-cc-tier:hover { background: rgba(255,255,255,0.06); }
    #${WIDGET_ID} .rio-cc-tier.selected { background: rgba(255,255,255,0.06); }
    #${WIDGET_ID} .rio-cc-tier:last-child { margin-bottom: 0; }
    #${WIDGET_ID} .rio-cc-tier-row {
      display: grid;
      grid-template-columns: minmax(0,1fr) auto auto;
      align-items: center;
      gap: 8px;
    }
    #${WIDGET_ID} .rio-cc-tier-label { font-size: 12px; font-weight: 600; }
    #${WIDGET_ID} .rio-cc-tier-value { font-size: 15px; font-weight: 700; tabular-nums: true; }
    #${WIDGET_ID} .rio-cc-tier-diff {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      color: #b7b7c6;
      white-space: nowrap;
    }
    #${WIDGET_ID} .rio-cc-progress-label {
      font-size: 9px;
      color: #8b8b9c;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 6px;
      margin-bottom: 2px;
    }
    #${WIDGET_ID} .rio-cc-track {
      margin-top: 2px;
      height: 6px;
      width: 100%;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      overflow: hidden;
    }
    #${WIDGET_ID} .rio-cc-track-fill { height: 100%; border-radius: 999px; transition: width .3s ease; }
    #${WIDGET_ID} .rio-cc-loading, #${WIDGET_ID} .rio-cc-error {
      font-size: 12px;
      color: #9a9aab;
      padding: 4px 0;
    }
    #${WIDGET_ID} .rio-cc-footer {
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 10px;
      color: #6a6a7a;
    }
    #${WIDGET_ID} .rio-cc-cta {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: #a78bfa;
      text-decoration: none;
      font-weight: 600;
    }
    #${WIDGET_ID} .rio-cc-cta:hover { text-decoration: underline; }
    #${WIDGET_ID} {
      position: static;
      width: auto;
      max-width: none;
      margin: 12px 0 0;
      padding: 12px 10px;
      color: #e7e7ee;
      background: transparent;
      border: 0;
      border-top: 1px solid rgba(255,255,255,0.12);
      border-radius: 0;
      box-shadow: none;
      overflow: visible;
      pointer-events: auto !important;
    }
    #${WIDGET_ID} .rio-cc-body { padding: 0; }
    #${WIDGET_ID} .rio-cc-mode {
      display: flex;
      justify-content: space-between;
      margin-top: 10px;
      color: #8b8b9c;
      font-size: 10px;
    }
    #${WIDGET_ID} .rio-cc-mode label,
    #${WIDGET_ID} .rio-cc-mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    #${WIDGET_ID} [data-display-mode] {
      width: 13px;
      height: 13px;
      margin: 0;
      accent-color: #a78bfa;
      cursor: pointer;
    }
    #${WIDGET_ID}.rio-cc-floating {
      position: fixed;
      right: 8px;
      bottom: 16px;
      z-index: 2147483647 !important;
      width: 350px;
      max-width: calc(100vw - 16px);
      margin: 0;
      padding: 0;
      background: #171821;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      overflow: hidden;
    }
    #${WIDGET_ID}.rio-cc-floating .rio-cc-body { padding: 14px; }
    #${WIDGET_ID}.rio-cc-floating .rio-cc-mode { display: none; }
    #${WIDGET_ID}.rio-cc-embedded .rio-cc-tier {
      background: #24252e;
    }
    #${WIDGET_ID}.rio-cc-embedded .rio-cc-tier:hover { background: #2b2c37; }
    #${WIDGET_ID}.rio-cc-embedded .rio-cc-tier.selected { background: #2b2c37; }
  `;
  document.head.appendChild(style);

  function parseCharacterUrl() {
    const m = window.location.pathname.match(/^\/characters\/([a-z]+)\/([^/]+)\/([^/]+)/i);
    if (!m) return null;
    return {
      region: decodeURIComponent(m[1]).toLowerCase(),
      realm: decodeURIComponent(m[2]),
      name: decodeURIComponent(m[3]),
    };
  }

  function cacheGet(key, maxAgeMs) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.t > maxAgeMs) return null;
      return parsed.v;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
    } catch {}
  }

  async function fetchJSON(url, signal) {
    const res = await fetch(url, { credentials: 'omit', signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function getCutoffs(region, signal) {
    const cacheKey = `rio_cc_cutoffs_${region}_${SEASON}`;
    const cached = cacheGet(cacheKey, CUTOFF_CACHE_MS);
    if (cached) return cached;
    const url = `https://raider.io/api/v1/mythic-plus/season-cutoffs?season=${encodeURIComponent(SEASON)}&region=${encodeURIComponent(region)}`;
    const data = await fetchJSON(url, signal);
    cacheSet(cacheKey, data);
    return data;
  }

  async function getProfile(region, realm, name, signal) {
    const cacheKey = `rio_cc_profile_${region}_${realm}_${name}`;
    const cached = cacheGet(cacheKey, PROFILE_CACHE_MS);
    if (cached) return cached;
    const url = `https://raider.io/api/v1/characters/profile?region=${encodeURIComponent(region)}&realm=${encodeURIComponent(realm)}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:${SEASON},guild`;
    const data = await fetchJSON(url, signal);
    cacheSet(cacheKey, data);
    return data;
  }

  function fmt(n, decimals = 1) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toFixed(decimals);
  }

  function fmtDiff(n) {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${fmt(n)} Rating`;
  }

  function extractScore(character) {
    const seasonEntry = character.mythic_plus_scores_by_season && character.mythic_plus_scores_by_season[0];
    return seasonEntry && seasonEntry.scores ? seasonEntry.scores.all : null;
  }

  function extractScoreColor(character) {
    const seasonEntry = character.mythic_plus_scores_by_season && character.mythic_plus_scores_by_season[0];
    const color = seasonEntry && seasonEntry.segments && seasonEntry.segments.all && seasonEntry.segments.all.color;
    return typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#60a5fa';
  }

  function getInitials(name) {
    const trimmed = (name || '').trim();
    return trimmed ? trimmed.slice(0, 2).toUpperCase() : '?';
  }

  function slugify(str, keepCase) {
    const base = (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/'/g, '').trim().replace(/\s+/g, '-');
    return keepCase ? base : base.toLowerCase();
  }

  function buildCharacterMeta(character) {
    const factionKey = (character.faction || '').toLowerCase();
    const faction = FACTION_INFO[factionKey] || null;
    const classColor = CLASS_COLORS[character.class] || '#e7e7ee';
    const region = (character.region || '').toLowerCase();
    const realmSlug = slugify(character.realm);

    const guild = character.guild;
    const guildRealmSlug = guild && guild.realm ? slugify(guild.realm) : realmSlug;
    const guildUrl = guild && guild.name
      ? `https://raider.io/guilds/${region}/${guildRealmSlug}/${slugify(guild.name, true)}`
      : null;

    return {
      classColor,
      bannerUrl: faction ? faction.banner : null,
      guildName: guild && guild.name ? guild.name : null,
      guildUrl,
      regionUrl: `https://raider.io/home/${region}`,
      realmUrl: `https://raider.io/home/${region}/${realmSlug}`,
      initials: getInitials(character.name),
    };
  }

  function resolveTiers(cutoffsData, score) {
    const cutoffs = cutoffsData.cutoffs || cutoffsData;
    return TIERS.map((t) => {
      const tierObj = cutoffs[t.key];
      const value = tierObj && tierObj.all ? tierObj.all.quantileMinValue : null;
      const hasData = value !== null && value !== undefined && score !== null;
      const diff = hasData ? score - value : null;
      const achieved = hasData ? diff >= 0 : false;
      const pct = hasData && value > 0 ? Math.min(100, Math.max(0, (score / value) * 100)) : 0;
      return { ...t, value, hasData, diff, achieved, pct };
    });
  }

  function pickPrimaryTier(tiersResolved) {
    if (state.selectedTierKey) {
      const chosen = tiersResolved.find((t) => t.key === state.selectedTierKey);
      if (chosen) return chosen;
    }
    const byKey = new Map(tiersResolved.map((t) => [t.key, t]));
    for (const key of PROGRESSION_ORDER) {
      const t = byKey.get(key);
      if (t && !t.achieved) return t;
    }
    return byKey.get(PROGRESSION_ORDER[PROGRESSION_ORDER.length - 1]) || tiersResolved[0];
  }

  function createFloatingContainer() {
    let el = document.getElementById(WIDGET_ID);
    if (el) return el;

    el = document.createElement('div');
    el.id = WIDGET_ID;
    el.innerHTML = `
      <div class="rio-cc-header" data-toggle>
        <span class="rio-cc-title">M+ Companion</span>
        <span class="rio-cc-mini-score" data-mini-score>—</span>
        <div class="rio-cc-controls">
          <label class="rio-cc-mode-toggle" title="Floating Widget">
            <input type="checkbox" data-display-mode aria-label="Floating Widget">
            Floating Widget
          </label>
          <button class="rio-cc-btn" data-refresh title="Refresh">&#8635;</button>
          <button class="rio-cc-btn" data-collapse title="Collapse">&#9472;</button>
        </div>
      </div>
      <div class="rio-cc-charhead-slot"></div>
      <div class="rio-cc-body"><div class="rio-cc-loading">Loading…</div></div>
    `;
    document.body.appendChild(el);

    function setCollapsed(collapsed) {
      el.classList.toggle('rio-cc-collapsed', collapsed);
      const collapseButton = el.querySelector('[data-collapse]');
      collapseButton.innerHTML = collapsed ? '&#43;' : '&#9472;';
      collapseButton.title = collapsed ? 'Expand' : 'Collapse';
      collapseButton.setAttribute('aria-label', collapseButton.title);
    }

    el.querySelector('[data-toggle]').addEventListener('click', (e) => {
      if (e.target.closest('[data-refresh], [data-collapse], [data-display-mode], .rio-cc-mode-toggle')) return;
      setCollapsed(!el.classList.contains('rio-cc-collapsed'));
    });
    const collapseButton = el.querySelector('[data-collapse]');
    let lastCollapsePointerDown = 0;
    collapseButton.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastCollapsePointerDown = Date.now();
      setCollapsed(!el.classList.contains('rio-cc-collapsed'));
    });
    collapseButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - lastCollapsePointerDown < 500) return;
      setCollapsed(!el.classList.contains('rio-cc-collapsed'));
    });
    el.querySelector('[data-refresh]').addEventListener('click', () => scheduleRender(true));
    const displayModeSelect = el.querySelector('[data-display-mode]');
    displayModeSelect.checked = state.displayMode === 'floating';
    displayModeSelect.addEventListener('change', () => setDisplayMode(displayModeSelect.checked ? 'floating' : 'embedded'));

    return el;
  }

  function ensureWidgetContainer() {
    let el = document.getElementById(WIDGET_ID);
    if (el && el.classList.contains(`rio-cc-${state.displayMode}`)) return el;
    if (el) el.remove();

    if (state.displayMode === 'floating') {
      el = createFloatingContainer();
      el.classList.add('rio-cc-floating');
      return el;
    }

    const target = Array.from(document.querySelectorAll('.rio-sidebar-section')).find((section) => {
      const header = section.querySelector(':scope > .rio-sidebar-header');
      return header && header.textContent.trim().toLowerCase() === 'recent timed mythic+ runs';
    });
    if (!target) return null;

    el = document.createElement('div');
    el.id = WIDGET_ID;
    el.classList.add('rio-cc-embedded');
    el.innerHTML = '<div class="rio-cc-body"><div class="rio-cc-loading">Loading...</div></div>';
    target.appendChild(el);
    return el;
  }

  function tierRowHtml(t, isSelected) {
    const selectedClass = isSelected ? ' selected' : '';
    const selectedBorder = isSelected ? `border-color:${t.color};` : '';

    if (!t.hasData) {
      return `
      <div class="rio-cc-tier${selectedClass}" data-tier="${t.key}" style="${selectedBorder}">
        <div class="rio-cc-tier-row">
          <span class="rio-cc-tier-label">${t.icon} ${t.label}</span>
          <span class="rio-cc-tier-value" style="color:${t.color}">—</span>
          <span class="rio-cc-tier-diff">Unavailable</span>
        </div>
      </div>`;
    }
    return `
      <div class="rio-cc-tier${selectedClass}" data-tier="${t.key}" style="${selectedBorder}">
        <div class="rio-cc-tier-row">
          <span class="rio-cc-tier-label">${t.icon} ${t.label}</span>
          <span class="rio-cc-tier-value" style="color:${t.color}">${fmt(t.value)}</span>
          <span class="rio-cc-tier-diff" style="${t.achieved ? 'background:rgba(52,211,153,0.15);color:#6ee7b0;' : ''}">
            ${t.achieved ? 'Achieved' : fmtDiff(t.diff)}
          </span>
        </div>
        <div class="rio-cc-progress-label">Progress</div>
        <div class="rio-cc-track">
          <div class="rio-cc-track-fill" style="width:${t.pct}%;background:${t.color}"></div>
        </div>
      </div>`;
  }

  function renderFloatingBody(container, character, cutoffsData) {
    const charheadSlot = container.querySelector('.rio-cc-charhead-slot');
    const body = container.querySelector('.rio-cc-body');
    const score = extractScore(character);
    const scoreColor = extractScoreColor(character);
    const meta = buildCharacterMeta(character);
    const miniScore = container.querySelector('[data-mini-score]');
    miniScore.textContent = fmt(score);
    miniScore.style.color = scoreColor;

    const tiersResolved = resolveTiers(cutoffsData, score);
    const primary = pickPrimaryTier(tiersResolved);

    const compareText = !primary.hasData
      ? '—'
      : primary.achieved
        ? 'Achieved'
        : `${fmt(Math.abs(primary.diff))} points remaining`;

    const guildPart = meta.guildName
      ? `<a href="${meta.guildUrl}" target="_blank" rel="noopener noreferrer">&lt;${meta.guildName}&gt;</a> - `
      : '';
    const specClassLine = [character.race, character.active_spec_name, character.class].filter(Boolean).join(' ');

    charheadSlot.innerHTML = `
      <div class="rio-cc-charhead" style="${meta.bannerUrl ? `background-image:url('${meta.bannerUrl}')` : ''}">
        <div class="rio-cc-charhead-content">
          <div class="rio-cc-charhead-left">
            <div class="rio-cc-avatar">
              <span class="rio-cc-avatar-fallback">${meta.initials}</span>
              ${character.thumbnail_url ? `<img src="${character.thumbnail_url}" onerror="this.style.display='none'" alt="" />` : ''}
            </div>
            <div class="rio-cc-charhead-info">
              <a class="rio-cc-charhead-name" style="color:${meta.classColor}" href="${character.profile_url || '#'}" target="_blank" rel="noopener noreferrer">${character.name || ''}</a>
              <div class="rio-cc-charhead-meta">
                ${guildPart}<a href="${meta.regionUrl}" target="_blank" rel="noopener noreferrer">(${(character.region || '').toUpperCase()})</a>
                <a href="${meta.realmUrl}" target="_blank" rel="noopener noreferrer">${character.realm || ''}</a>
              </div>
              <div class="rio-cc-charhead-class" style="color:${meta.classColor}">${specClassLine}</div>
            </div>
          </div>
          <div class="rio-cc-charhead-score">
            <div class="rio-cc-charhead-score-label">M+ Score</div>
            <div class="rio-cc-charhead-score-value" style="color:${scoreColor}">${fmt(score)}</div>
          </div>
        </div>
      </div>
    `;

    body.innerHTML = `
      <div class="rio-cc-lower">
        <div class="rio-cc-compare-row">
          <span class="rio-cc-compare-label">${primary.label} <span class="rio-cc-compare-muted">— ${fmt(primary.value)}</span></span>
          <span class="rio-cc-compare-diff" style="color:${primary.achieved ? '#6ee7b0' : '#f87171'}">${compareText}</span>
        </div>
        <div class="rio-cc-progress-label">Progress</div>
        <div class="rio-cc-track">
          <div class="rio-cc-track-fill" style="width:${primary.pct}%;background:${primary.color}"></div>
        </div>
      </div>

      ${tiersResolved.map((t) => tierRowHtml(t, t.key === primary.key)).join('')}

      <div class="rio-cc-footer">
        <a
          class="rio-cc-cta"
          href="https://mpluscompanion.lovable.app/character/${encodeURIComponent(character.region)}/${encodeURIComponent(character.realm)}/${encodeURIComponent(character.name)}"
          target="_blank"
          rel="noopener noreferrer"
        >View Dashboard &#8599;</a>
        <span>Season ${SEASON.toUpperCase()} • ${(character.region || '').toUpperCase()}</span>
      </div>
    `;

    body.querySelectorAll('[data-tier]').forEach((card) => {
      card.addEventListener('click', () => {
        const key = card.getAttribute('data-tier');
        state.selectedTierKey = key;
        try {
          localStorage.setItem(TIER_STORAGE_KEY, key);
        } catch {}
        if (state.lastCharacter && state.lastCutoffsData) {
          renderBody(container, state.lastCharacter, state.lastCutoffsData);
        }
      });
    });
  }

  function renderEmbeddedBody(container, character, cutoffsData) {
    const body = container.querySelector('.rio-cc-body');
    const score = extractScore(character);
    const tiersResolved = resolveTiers(cutoffsData, score);
    const primary = pickPrimaryTier(tiersResolved);
    const compareText = !primary.hasData
      ? '—'
      : primary.achieved
        ? 'Achieved'
        : `${fmt(Math.abs(primary.diff))} points remaining`;

    body.innerHTML = `
      <div class="rio-cc-lower">
        <div class="rio-cc-compare-row">
          <span class="rio-cc-compare-label">${primary.label} <span class="rio-cc-compare-muted">— ${fmt(primary.value)}</span></span>
          <span class="rio-cc-compare-diff" style="color:${primary.achieved ? '#6ee7b0' : '#f87171'}">${compareText}</span>
        </div>
        <div class="rio-cc-progress-label">Progress</div>
        <div class="rio-cc-track">
          <div class="rio-cc-track-fill" style="width:${primary.pct}%;background:${primary.color}"></div>
        </div>
      </div>
      ${tiersResolved.map((tier) => tierRowHtml(tier, tier.key === primary.key)).join('')}
      <div class="rio-cc-mode">
      <a class="rio-cc-cta" href="https://mpluscompanion.lovable.app/character/${encodeURIComponent(character.region)}/${encodeURIComponent(character.realm)}/${encodeURIComponent(character.name)}"
          target="_blank" rel="noopener noreferrer">View Dashboard &#8599;</a>
        <label>
          <input type="checkbox" data-display-mode aria-label="Floating Widget">
          Floating Widget
        </label>
      </div>
    `;

    body.querySelectorAll('[data-tier]').forEach((card) => {
      card.addEventListener('click', () => {
        state.selectedTierKey = card.getAttribute('data-tier');
        try {
          localStorage.setItem(TIER_STORAGE_KEY, state.selectedTierKey);
        } catch {}
        if (state.lastCharacter && state.lastCutoffsData) {
          renderBody(container, state.lastCharacter, state.lastCutoffsData);
        }
      });
    });
    const displayModeSelect = body.querySelector('[data-display-mode]');
    displayModeSelect.checked = state.displayMode === 'floating';
    displayModeSelect.addEventListener('change', () => setDisplayMode(displayModeSelect.checked ? 'floating' : 'embedded'));
  }

  function renderBody(container, character, cutoffsData) {
    if (state.displayMode === 'floating') {
      renderFloatingBody(container, character, cutoffsData);
      return;
    }
    renderEmbeddedBody(container, character, cutoffsData);
  }

  function setDisplayMode(mode) {
    if (mode !== 'embedded' && mode !== 'floating') return;
    state.displayMode = mode;
    try {
      localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
    } catch {}

    const container = ensureWidgetContainer();
    if (container && state.lastCharacter && state.lastCutoffsData) {
      renderBody(container, state.lastCharacter, state.lastCutoffsData);
    } else {
      scheduleRender(true);
    }
  }

  function renderError(container, message) {
    container.querySelector('.rio-cc-body').innerHTML = `<div class="rio-cc-error">Unable to load data.</div>`;
  }

  function getCharacterKey() {
    const info = parseCharacterUrl();
    return info ? `${info.region}/${info.realm}/${info.name}` : null;
  }

  function cancelActiveRender() {
    if (state.renderController) {
      state.renderController.abort();
      state.renderController = null;
    }
  }

  function isProfileReady() {
    return Boolean(parseCharacterUrl() && document.body);
  }

  function waitUntilReady() {
    if (isProfileReady()) return Promise.resolve(true);
    if (state.readyPromise) return state.readyPromise;

    state.readyPromise = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (isProfileReady()) finish(true);
      });
      const timeout = window.setTimeout(() => finish(false), READY_TIMEOUT_MS);

      function finish(ready) {
        observer.disconnect();
        window.clearTimeout(timeout);
        state.readyPromise = null;
        resolve(ready);
      }

      observer.observe(document.documentElement, { childList: true, subtree: true });
    });

    return state.readyPromise;
  }

  function scheduleRender(force = false) {
    state.pendingForceRender = state.pendingForceRender || force;
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(async () => {
      const shouldForce = state.pendingForceRender;
      state.pendingForceRender = false;

      if (!parseCharacterUrl()) {
        render(false);
        return;
      }

      if (await waitUntilReady()) render(shouldForce);
    }, RENDER_DEBOUNCE_MS);
  }

  async function render(force) {
    const info = parseCharacterUrl();
    if (!info) {
      cancelActiveRender();
      const existing = document.getElementById(WIDGET_ID);
      if (existing) existing.remove();
      state.currentKey = null;
      state.renderingKey = null;
      return;
    }

    const key = `${info.region}/${info.realm}/${info.name}`;
    if (!force && (
      (key === state.currentKey && document.getElementById(WIDGET_ID)) ||
      key === state.renderingKey
    )) {
      return;
    }

    cancelActiveRender();
    const controller = new AbortController();
    const requestId = ++state.renderRequestId;
    state.renderController = controller;
    state.renderingKey = key;

    const container = ensureWidgetContainer();
    if (!container) {
      state.renderingKey = null;
      state.renderController = null;
      return;
    }
    container.querySelector('.rio-cc-body').innerHTML = '<div class="rio-cc-loading">Loading…</div>';

    try {
      const [profile, cutoffsData] = await Promise.all([
        getProfile(info.region, info.realm, info.name, controller.signal),
        getCutoffs(info.region, controller.signal),
      ]);

      if (controller.signal.aborted || requestId !== state.renderRequestId || key !== getCharacterKey()) return;

      if (profile.error) {
        renderError(container, 'Character not found.');
        return;
      }

      profile.region = profile.region || info.region;
      state.lastCharacter = profile;
      state.lastCutoffsData = cutoffsData;
      state.currentKey = key;
      renderBody(container, profile, cutoffsData);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (requestId !== state.renderRequestId || key !== getCharacterKey()) return;
      renderError(container, err.message || String(err));
    } finally {
      if (requestId === state.renderRequestId) {
        state.renderingKey = null;
        state.renderController = null;
      }
    }
  }

  function hookHistory() {
    const fire = () => window.dispatchEvent(new Event('rio-cc-locationchange'));
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function (...args) {
      const ret = _pushState.apply(this, args);
      fire();
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = _replaceState.apply(this, args);
      fire();
      return ret;
    };
    window.addEventListener('popstate', fire);
  }

  function observePage() {
    let observedKey = getCharacterKey();
    const observer = new MutationObserver(() => {
      const key = getCharacterKey();

      if (key !== observedKey) {
        observedKey = key;
        scheduleRender(false);
        return;
      }

      if (!key) {
        if (state.currentKey || state.renderingKey || document.getElementById(WIDGET_ID)) scheduleRender(false);
        return;
      }

      if (!document.getElementById(WIDGET_ID) || (key !== state.currentKey && key !== state.renderingKey)) scheduleRender(false);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  hookHistory();
  window.addEventListener('rio-cc-locationchange', () => {
    cancelActiveRender();
    state.renderingKey = null;
    scheduleRender(false);
  });
  observePage();
  scheduleRender(false);
})();
