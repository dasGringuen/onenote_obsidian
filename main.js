'use strict';

/*
 * Section Pages - a two-pane notebook navigator for Obsidian.
 *
 *   Left pane  : folders shown as colored sections (folders that contain folders are collapsible groups)
 *   Right pane : the notes of the selected section as a flat, hand-ordered list with up to five
 *                indent levels. A page with subpages is still an ordinary note - no folder notes.
 *
 * Order and indent live in each note's properties (page-order, page-level).
 * Colors, collapsed state and the last-open page per section live in the plugin's data file.
 */

const {
  Plugin, ItemView, Menu, Modal, Notice, TFile, TFolder,
  PluginSettingTab, Setting, normalizePath, debounce, setIcon,
  TextFileView, MarkdownView, MarkdownRenderer, Component, Keymap,
} = require('obsidian');

const VIEW_TYPE = 'section-pages';
const ORDER_KEY = 'page-order';
const LEVEL_KEY = 'page-level';
const TYPE_KEY = 'page-type';
const FREEFORM = 'freeform';
const FREEFORM_VIEW = 'section-pages-freeform';
const DEFAULT_BOX_W = 420;
const MIN_BOX_W = 120;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];
const MAX_LEVEL = 4;      // five levels: 0 to 4
const STEP = 100;         // spacing used when numbering pages
const MIN_GAP = 0.01;     // below this, renumber the whole section

const PALETTE = [
  { name: 'Blue', value: '#2f6fc4' },
  { name: 'Green', value: '#3f9142' },
  { name: 'Lime', value: '#8cc63f' },
  { name: 'Orange', value: '#ee7a30' },
  { name: 'Red', value: '#d9362f' },
  { name: 'Magenta', value: '#c2187a' },
  { name: 'Purple', value: '#7b4bb5' },
  { name: 'Teal', value: '#2a9d9a' },
  { name: 'Yellow', value: '#f4c430' },
  { name: 'Tan', value: '#c4a57b' },
  { name: 'Gray', value: '#8f979c' },
];

const DEFAULT_DATA = {
  rootFolder: '',
  attachmentsFolder: 'assets',
  activeSection: null,
  lastPage: {},
  collapsedPages: {},
  collapsedGroups: {},
  groups: {},
  colors: {},
  colorCursor: 0,
  split: 42,
};

/* ------------------------------------------------------------------ */
/* Pure logic (no Obsidian calls) so it can be tested on its own       */
/* ------------------------------------------------------------------ */

function toNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function clampLevel(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_LEVEL, n));
}

/** Ordered pages first (by page-order), then unordered ones by name. */
function sortPages(items) {
  return items.slice().sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : Infinity;
    const bo = Number.isFinite(b.order) ? b.order : Infinity;
    if (ao !== bo) return ao < bo ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** A page can be at most one level deeper than the page above it. */
function effectiveLevels(items) {
  const out = [];
  let prev = -1;
  for (const it of items) {
    let l = clampLevel(it.level);
    if (l > prev + 1) l = prev + 1;
    out.push(l);
    prev = l;
  }
  return out;
}

/** Index just past the last descendant of the page at index i. */
function subtreeEnd(levels, i) {
  let j = i + 1;
  while (j < levels.length && levels[j] > levels[i]) j++;
  return j;
}

/**
 * Given pages in their desired final sequence, return the page-order value for each.
 * The longest run of unmoved pages whose values are already increasing keeps its values, and
 * only the rest get new ones in the gaps, so a reorder rewrites as few notes as it can. Every
 * write is a file change the sync client has to carry, and rewriting a whole section at once is
 * what produces sync conflicts. Falls back to renumbering only when a gap is too small.
 */
function keptIndices(seq, moved) {
  // Longest strictly increasing subsequence of page-order among unmoved pages that have one.
  const idx = [];
  for (let i = 0; i < seq.length; i++) {
    if (!moved.has(seq[i].path) && Number.isFinite(seq[i].order)) idx.push(i);
  }
  const len = idx.map(() => 1);
  const prev = idx.map(() => -1);
  let best = -1;
  for (let a = 0; a < idx.length; a++) {
    for (let b = 0; b < a; b++) {
      if (seq[idx[b]].order < seq[idx[a]].order && len[b] + 1 > len[a]) { len[a] = len[b] + 1; prev[a] = b; }
    }
    if (best < 0 || len[a] > len[best]) best = a;
  }
  const keep = new Set();
  for (let a = best; a >= 0; a = prev[a]) keep.add(idx[a]);
  return keep;
}

function planOrders(seq, moved) {
  const n = seq.length;
  const result = new Array(n);
  let ok = true;
  const keep = keptIndices(seq, moved);
  for (const k of keep) result[k] = seq[k].order;
  let i = 0;
  while (ok && i < n) {
    if (keep.has(i)) { i++; continue; }
    let j = i;
    while (j < n && !keep.has(j)) j++;
    const len = j - i;
    let lo = i > 0 ? result[i - 1] : null;
    let hi = j < n ? result[j] : null;
    if (lo === null && hi === null) { lo = 0; hi = (len + 1) * STEP; }
    else if (lo === null) lo = hi - (len + 1) * STEP;
    else if (hi === null) hi = lo + (len + 1) * STEP;
    const step = (hi - lo) / (len + 1);
    if (step < MIN_GAP) { ok = false; break; }
    for (let k = 0; k < len; k++) result[i + k] = Math.round((lo + step * (k + 1)) * 10000) / 10000;
    i = j;
  }
  if (!ok) for (let k = 0; k < n; k++) result[k] = (k + 1) * STEP;
  return result;
}

function remapPath(p, oldPath, newPath) {
  if (p === oldPath) return newPath;
  if (typeof p === 'string' && p.startsWith(oldPath + '/')) return newPath + p.slice(oldPath.length);
  return p;
}

function remapKeys(obj, oldPath, newPath) {
  const out = {};
  for (const k of Object.keys(obj)) out[remapPath(k, oldPath, newPath)] = obj[k];
  return out;
}

/* ---- Freeform pages: a note whose body is a set of positioned boxes ----
 *
 *   %% box x=40 y=60 w=420 %%
 *
 *   Any Markdown here.
 *
 * The markers are Obsidian comments, so the file still reads as a normal note anywhere else.
 */

const BOX_RE = /^%%\s*box\b([^%]*)%%\s*$/;

function splitFront(data) {
  const text = String(data || '');
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (m) return [m[0], text.slice(m[0].length)];
  return ['', text];
}

function isFreeformText(data) {
  return /^page-type:[ \t]*["']?freeform["']?[ \t]*$/m.test(splitFront(data)[0]);
}

function boxAttr(attrs, key, fallback) {
  const m = new RegExp('(?:^|\\s)' + key + '=(-?\\d+(?:\\.\\d+)?)').exec(attrs);
  if (!m) return fallback;
  const n = Math.round(Number(m[1]));
  return Number.isFinite(n) ? n : fallback;
}

function trimBlankLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function parseBoxes(body) {
  const boxes = [];
  const pre = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = trimBlankLines(cur.lines.join('\n'));
    if (text) {
      const box = { x: cur.x, y: cur.y, w: cur.w, text };
      if (cur.h > 0) box.h = cur.h; // height is optional: without it a box is as tall as its text
      boxes.push(box);
    }
    cur = null;
  };
  for (const line of String(body || '').split(/\r?\n/)) {
    const m = BOX_RE.exec(line.trim());
    if (m) {
      flush();
      cur = {
        x: Math.max(0, boxAttr(m[1], 'x', 40)),
        y: Math.max(0, boxAttr(m[1], 'y', 40)),
        w: Math.max(MIN_BOX_W, boxAttr(m[1], 'w', DEFAULT_BOX_W)),
        h: Math.max(0, boxAttr(m[1], 'h', 0)),
        lines: [],
      };
    } else if (cur) cur.lines.push(line);
    else pre.push(line);
  }
  flush();
  // Text that is not in any box yet (a normal note just converted) becomes one box at the top.
  const preText = trimBlankLines(pre.join('\n'));
  if (preText) boxes.unshift({ x: 40, y: 20, w: 560, text: preText });
  return boxes;
}

function sortedBoxes(boxes) {
  return boxes.filter((b) => b.text && b.text.trim()).slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function serializeBoxes(boxes) {
  const list = sortedBoxes(boxes);
  if (!list.length) return '';
  return '\n' + list.map((b) => `%% box x=${b.x} y=${b.y} w=${b.w}${b.h > 0 ? ' h=' + b.h : ''} %%\n\n${trimBlankLines(b.text)}\n`).join('\n');
}

/** Body of a freeform page as plain Markdown, boxes in reading order. */
function stripBoxMarkers(body) {
  const list = sortedBoxes(parseBoxes(body));
  if (!list.length) return '';
  return '\n' + list.map((b) => trimBlankLines(b.text)).join('\n\n') + '\n';
}

function validName(name) {
  return !!name && !/[\\/:*?"<>|#^[\]]/.test(name);
}

/* ------------------------------------------------------------------ */
/* Small modals                                                        */
/* ------------------------------------------------------------------ */

class PromptModal extends Modal {
  constructor(app, title, value, done) {
    super(app);
    this.title = title;
    this.value = value;
    this.done = done;
    this.result = null;
  }
  onOpen() {
    this.titleEl.setText(this.title);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'sp-prompt-input' });
    input.value = this.value;
    const submit = () => { this.result = input.value.trim(); this.close(); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    const buttons = this.contentEl.createDiv({ cls: 'sp-modal-buttons' });
    const ok = buttons.createEl('button', { text: 'OK', cls: 'mod-cta' });
    ok.addEventListener('click', submit);
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() {
    this.contentEl.empty();
    this.done(this.result);
  }
}

function promptText(app, title, value) {
  return new Promise((resolve) => new PromptModal(app, title, value, resolve).open());
}

class ConfirmModal extends Modal {
  constructor(app, message, done) {
    super(app);
    this.message = message;
    this.done = done;
    this.result = false;
  }
  onOpen() {
    this.contentEl.createEl('p', { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: 'sp-modal-buttons' });
    const yes = buttons.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    yes.addEventListener('click', () => { this.result = true; this.close(); });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
  }
  onClose() {
    this.contentEl.empty();
    this.done(this.result);
  }
}

function confirmDelete(app, message) {
  return new Promise((resolve) => new ConfirmModal(app, message, resolve).open());
}

class ColorModal extends Modal {
  constructor(app, current, done) {
    super(app);
    this.current = current;
    this.done = done;
  }
  onOpen() {
    this.titleEl.setText('Section color');
    const grid = this.contentEl.createDiv({ cls: 'sp-swatches' });
    for (const c of PALETTE) {
      const sw = grid.createDiv({ cls: 'sp-swatch', attr: { 'aria-label': c.name } });
      sw.style.backgroundColor = c.value;
      if (c.value === this.current) sw.addClass('is-current');
      sw.addEventListener('click', () => { this.done(c.value); this.close(); });
    }
    const custom = this.contentEl.createDiv({ cls: 'sp-custom-color' });
    custom.createSpan({ text: 'Custom: ' });
    const input = custom.createEl('input', { type: 'color' });
    input.value = /^#[0-9a-f]{6}$/i.test(this.current || '') ? this.current : '#2f6fc4';
    input.addEventListener('change', () => { this.done(input.value); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

class NavView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.kbPath = null;        // page selected with the keyboard / last clicked
    this.visiblePaths = [];
    this.dragPath = null;      // page being dragged
    this.dragSection = null;   // section or group being dragged
    this.lastScrolledTo = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Sections and pages'; }
  getIcon() { return 'book-open'; }

  async onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass('sp-root');

    this.wrap = el.createDiv({ cls: 'sp-wrap' });
    this.wrap.style.setProperty('--sp-split', this.plugin.data.split + '%');

    const left = this.wrap.createDiv({ cls: 'sp-pane sp-sections-pane' });
    this.sectionList = left.createDiv({ cls: 'sp-list' });
    const addSection = left.createDiv({ cls: 'sp-footer', text: '+ Add section' });
    addSection.addEventListener('click', () => this.plugin.newSection(this.plugin.getRoot()));
    const addGroup = left.createDiv({ cls: 'sp-footer sp-footer-second', text: '+ Add group' });
    addGroup.addEventListener('click', () => this.plugin.newGroup(this.plugin.getRoot()));

    // Dropping a section on the empty part of the list moves it out of its group, to the top level.
    this.sectionList.addEventListener('dragover', (e) => {
      if (!this.dragSection || e.target !== this.sectionList) return;
      const root = this.plugin.getRoot();
      if (!root || !this.plugin.canMoveSection(this.dragSection, root)) return;
      e.preventDefault();
      this.sectionList.addClass('sp-drop-root');
    });
    this.sectionList.addEventListener('dragleave', (e) => {
      if (e.target === this.sectionList) this.sectionList.removeClass('sp-drop-root');
    });
    this.sectionList.addEventListener('drop', (e) => {
      if (!this.dragSection || e.target !== this.sectionList) return;
      e.preventDefault();
      this.sectionList.removeClass('sp-drop-root');
      const src = this.dragSection;
      this.dragSection = null;
      this.plugin.moveSection(src, this.plugin.getRoot());
    });

    const divider = this.wrap.createDiv({ cls: 'sp-divider' });
    divider.addEventListener('mousedown', (e) => this.startResize(e));

    const right = this.wrap.createDiv({ cls: 'sp-pane sp-pages-pane' });
    this.pageList = right.createDiv({ cls: 'sp-list', attr: { tabindex: '0' } });
    this.pageList.addEventListener('keydown', (e) => this.onKey(e));
    const addPage = right.createDiv({ cls: 'sp-footer', text: '+ Add page' });
    addPage.addEventListener('click', () => this.plugin.newPage(this.plugin.getActiveSection(), null));
    const addFree = right.createDiv({ cls: 'sp-footer sp-footer-second', text: '+ Add freeform page' });
    addFree.addEventListener('click', () => this.plugin.newPage(this.plugin.getActiveSection(), null, true));

    this.render();
  }

  async onClose() { this.contentEl.empty(); }

  startResize(e) {
    e.preventDefault();
    const move = (ev) => {
      const rect = this.wrap.getBoundingClientRect();
      if (rect.width <= 0) return;
      let pct = ((ev.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(20, Math.min(70, pct));
      this.plugin.data.split = Math.round(pct);
      this.wrap.style.setProperty('--sp-split', this.plugin.data.split + '%');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      this.plugin.saveSoon();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  render() {
    if (!this.sectionList || !this.pageList) return;
    const s1 = this.sectionList.scrollTop;
    const s2 = this.pageList.scrollTop;
    this.renderSections();
    this.renderPages();
    this.sectionList.scrollTop = s1;
    this.pageList.scrollTop = s2;
    this.scrollActiveIntoView();
  }

  /* ---------------- sections (left pane) ---------------- */

  renderSections() {
    const plugin = this.plugin;
    const list = this.sectionList;
    list.empty();
    const root = plugin.getRoot();
    if (!root) {
      list.createDiv({ cls: 'sp-empty', text: 'Root folder not found. Check the plugin settings.' });
      return;
    }
    const active = plugin.getActiveSection();
    const activePath = active ? active.path : null;

    if (plugin.hasNotes(root)) {
      const label = root.isRoot() ? this.app.vault.getName() : root.name;
      this.sectionRow(list, root, label, 0, [], activePath, true);
    }
    const walk = (folder, depth) => {
      for (const f of plugin.childFolders(folder)) {
        const kids = plugin.childFolders(f);
        this.sectionRow(list, f, f.name, depth, kids, activePath, false);
        if (kids.length && !plugin.data.collapsedGroups[f.path]) walk(f, depth + 1);
      }
    };
    walk(root, 0);
    if (!list.children.length) {
      list.createDiv({ cls: 'sp-empty', text: 'No sections yet.' });
    }
  }

  sectionRow(list, folder, label, depth, kids, activePath, isRootRow) {
    const plugin = this.plugin;
    // A group only holds sections: no color strip, and clicking it opens or closes it.
    const isGroup = !isRootRow && plugin.isGroup(folder);
    const row = list.createDiv({ cls: 'sp-row sp-section' });
    row.style.setProperty('--sp-depth', String(depth));
    if (isGroup) row.addClass('is-group');
    else if (folder.path === activePath) row.addClass('is-active');

    const toggle = () => {
      if (plugin.data.collapsedGroups[folder.path]) delete plugin.data.collapsedGroups[folder.path];
      else plugin.data.collapsedGroups[folder.path] = true;
      plugin.saveSoon();
      this.render();
    };
    const chev = row.createDiv({ cls: 'sp-chevron' });
    if (kids.length || isGroup) {
      setIcon(chev, plugin.data.collapsedGroups[folder.path] ? 'chevron-right' : 'chevron-down');
      chev.addClass('is-clickable');
      chev.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    }
    const tab = row.createDiv({ cls: 'sp-tab' });
    if (isGroup) tab.addClass('is-group');
    else tab.style.backgroundColor = plugin.colorFor(folder.path);
    row.createDiv({ cls: 'sp-label', text: label });

    row.addEventListener('click', () => {
      if (isGroup) toggle();
      else plugin.selectSection(folder.path, true);
    });
    if (isRootRow) return;
    row.addEventListener('contextmenu', (e) => this.sectionMenu(e, folder, isGroup));

    // Sections and groups can be dragged into a group, or onto empty space to leave one.
    row.setAttr('draggable', 'true');
    row.addEventListener('dragstart', (e) => {
      this.dragSection = folder.path;
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', folder.name);
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    row.addEventListener('dragend', () => { this.dragSection = null; this.clearDropMarks(); });

    const accepts = () => {
      if (this.dragPath) return !isGroup; // a page goes into a section
      if (this.dragSection) return isGroup && plugin.canMoveSection(this.dragSection, folder);
      return false;
    };
    row.addEventListener('dragover', (e) => {
      if (!accepts()) return;
      e.preventDefault();
      row.addClass('sp-drop-into');
    });
    row.addEventListener('dragleave', () => row.removeClass('sp-drop-into'));
    row.addEventListener('drop', (e) => {
      if (!accepts()) return;
      e.preventDefault();
      row.removeClass('sp-drop-into');
      if (this.dragPath) {
        const src = this.dragPath;
        this.dragPath = null;
        plugin.movePageToSection(src, folder);
      } else {
        const src = this.dragSection;
        this.dragSection = null;
        plugin.moveSection(src, folder);
      }
    });
  }

  sectionMenu(evt, folder, isGroup) {
    evt.preventDefault();
    const plugin = this.plugin;
    const root = plugin.getRoot();
    const menu = new Menu();
    if (!isGroup) {
      menu.addItem((i) => i.setTitle('New page').setIcon('file-plus').onClick(() => {
        plugin.selectSection(folder.path, false);
        plugin.newPage(folder, null);
      }));
    }
    menu.addItem((i) => i.setTitle('New section inside').setIcon('folder-plus').onClick(() => plugin.newSection(folder)));
    menu.addItem((i) => i.setTitle('New group inside').setIcon('folders').onClick(() => plugin.newGroup(folder)));
    menu.addSeparator();
    if (!isGroup) {
      menu.addItem((i) => i.setTitle('Color...').setIcon('palette').onClick(() => {
        new ColorModal(this.app, plugin.data.colors[folder.path], (value) => {
          plugin.data.colors[folder.path] = value;
          plugin.saveSoon();
          plugin.refreshViews();
        }).open();
      }));
    }
    menu.addItem((i) => i.setTitle('Rename...').setIcon('pencil').onClick(() => plugin.renameSection(folder)));
    const parent = folder.parent;
    if (root && parent && parent !== root && parent.parent && plugin.isUnderRoot(parent.parent)) {
      menu.addItem((i) => i.setTitle('Move out of "' + parent.name + '"').setIcon('corner-left-up')
        .onClick(() => plugin.moveSection(folder.path, parent.parent)));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(isGroup ? 'Delete group' : 'Delete section').setIcon('trash').onClick(() => plugin.deleteSection(folder)));
    menu.showAtMouseEvent(evt);
  }

  /* ---------------- pages (right pane) ---------------- */

  renderPages() {
    const plugin = this.plugin;
    const list = this.pageList;
    list.empty();
    this.visiblePaths = [];
    const folder = plugin.getActiveSection();
    if (!folder) {
      list.createDiv({ cls: 'sp-empty', text: 'Select a section.' });
      return;
    }
    const items = plugin.pagesOf(folder);
    const levels = effectiveLevels(items);
    const activePath = plugin.activePath();

    let hideBelow = null;
    for (let i = 0; i < items.length; i++) {
      if (hideBelow !== null) {
        if (levels[i] > hideBelow) continue;
        hideBelow = null;
      }
      const it = items[i];
      const hasChildren = i + 1 < items.length && levels[i + 1] > levels[i];
      const collapsed = hasChildren && !!plugin.data.collapsedPages[it.path];
      if (collapsed) hideBelow = levels[i];
      this.pageRow(list, folder, it, levels[i], hasChildren, collapsed, activePath);
      this.visiblePaths.push(it.path);
    }
    if (!items.length) list.createDiv({ cls: 'sp-empty', text: 'No pages yet.' });
  }

  pageRow(list, folder, it, level, hasChildren, collapsed, activePath) {
    const plugin = this.plugin;
    const row = list.createDiv({ cls: 'sp-row sp-page' });
    row.dataset.path = it.path;
    row.style.setProperty('--sp-depth', String(level));
    if (it.path === activePath) row.addClass('is-active');
    if (it.path === this.kbPath && it.path !== activePath) row.addClass('is-selected');

    const chev = row.createDiv({ cls: 'sp-chevron' });
    if (hasChildren) {
      setIcon(chev, collapsed ? 'chevron-right' : 'chevron-down');
      chev.addClass('is-clickable');
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsed) delete plugin.data.collapsedPages[it.path];
        else plugin.data.collapsedPages[it.path] = true;
        plugin.saveSoon();
        this.render();
      });
    }
    row.createDiv({ cls: 'sp-label', text: it.name });

    // Like OneNote: a click shows the page but keeps keyboard focus in the page list,
    // so arrows and Tab / Shift+Tab act on pages. Click into the note to type.
    row.addEventListener('click', () => {
      this.kbPath = it.path;
      this.pageList.focus();
      // Obsidian focuses the editor when it loads a file into the active tab; take focus back.
      plugin.openPage(it.file, false).then(() => {
        this.pageList.focus();
        window.setTimeout(() => this.pageList.focus(), 60);
      });
    });
    row.addEventListener('dblclick', () => plugin.openPage(it.file, true));
    row.addEventListener('contextmenu', (e) => this.pageMenu(e, folder, it));

    row.setAttr('draggable', 'true');
    row.addEventListener('dragstart', (e) => {
      this.dragPath = it.path;
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', it.name);
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    row.addEventListener('dragend', () => { this.dragPath = null; this.clearDropMarks(); });
    row.addEventListener('dragover', (e) => {
      if (!this.dragPath || this.dragPath === it.path) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      row.toggleClass('sp-drop-before', before);
      row.toggleClass('sp-drop-after', !before);
    });
    row.addEventListener('dragleave', () => {
      row.removeClass('sp-drop-before');
      row.removeClass('sp-drop-after');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const where = row.hasClass('sp-drop-before') ? 'before' : 'after';
      this.clearDropMarks();
      const src = this.dragPath;
      this.dragPath = null;
      if (src && src !== it.path) plugin.movePage(folder, src, it.path, where);
    });
  }

  clearDropMarks() {
    this.contentEl.querySelectorAll('.sp-drop-before, .sp-drop-after, .sp-drop-into, .sp-drop-root').forEach((el) => {
      el.classList.remove('sp-drop-before', 'sp-drop-after', 'sp-drop-into', 'sp-drop-root');
    });
  }

  pageMenu(evt, folder, it) {
    evt.preventDefault();
    const plugin = this.plugin;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('New page below').setIcon('file-plus').onClick(() => plugin.newPage(folder, it.path)));
    menu.addItem((i) => i.setTitle('New subpage').setIcon('corner-down-right').onClick(() => plugin.newPage(folder, it.path, false, true)));
    menu.addItem((i) => i.setTitle('New freeform page below').setIcon('layout-dashboard').onClick(() => plugin.newPage(folder, it.path, true)));
    if (plugin.isFreeform(it.file)) {
      menu.addItem((i) => i.setTitle('Convert to normal page').setIcon('file-text').onClick(() => plugin.convertToNormal(it.file)));
    } else {
      menu.addItem((i) => i.setTitle('Convert to freeform page').setIcon('layout-dashboard').onClick(() => plugin.convertToFreeform(it.file)));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Make subpage').setIcon('indent').onClick(() => plugin.indentPage(folder, it.path, 1)));
    menu.addItem((i) => i.setTitle('Promote subpage').setIcon('outdent').onClick(() => plugin.indentPage(folder, it.path, -1)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Rename...').setIcon('pencil').onClick(() => plugin.renamePage(it.file)));
    menu.addItem((i) => i.setTitle('Delete page').setIcon('trash').onClick(() => plugin.trash(it.file)));
    menu.showAtMouseEvent(evt);
  }

  onKey(e) {
    const plugin = this.plugin;
    const folder = plugin.getActiveSection();
    if (!folder) return;
    const cur = this.kbPath || plugin.activePath();

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.visiblePaths.length) return;
      let idx = this.visiblePaths.indexOf(cur);
      if (idx < 0) idx = e.key === 'ArrowDown' ? -1 : this.visiblePaths.length;
      idx += e.key === 'ArrowDown' ? 1 : -1;
      idx = Math.max(0, Math.min(this.visiblePaths.length - 1, idx));
      const file = this.app.vault.getAbstractFileByPath(this.visiblePaths[idx]);
      if (file instanceof TFile) {
        this.kbPath = file.path;
        this.render();
        plugin.openPage(file, false).then(() => {
          this.pageList.focus();
          window.setTimeout(() => this.pageList.focus(), 60);
        });
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (cur) plugin.indentPage(folder, cur, e.shiftKey ? -1 : 1);
    }
  }

  scrollActiveIntoView() {
    const target = this.kbPath || this.plugin.activePath();
    if (!target || target === this.lastScrolledTo) return;
    for (const row of Array.from(this.pageList.children)) {
      if (row.dataset && row.dataset.path === target) {
        row.scrollIntoView({ block: 'nearest' });
        this.lastScrolledTo = target;
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Freeform page view                                                  */
/* ------------------------------------------------------------------ */

class FreeformView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.front = '';
    this.boxes = [];
    this.lastBody = null;
    this.localDirty = false;
    this.selected = null;
    this.editing = null;
    this.built = false;
  }

  getViewType() { return FREEFORM_VIEW; }
  getDisplayText() { return this.file ? this.file.basename : 'Freeform page'; }
  getIcon() { return 'layout-dashboard'; }
  canAcceptExtension(extension) { return extension === 'md'; }

  async onOpen() { this.build(); }

  build() {
    if (this.built) return;
    this.built = true;
    const root = this.contentEl;
    root.empty();
    root.addClass('sp-ff-root');
    const head = root.createDiv({ cls: 'sp-ff-head' });
    this.ffTitle = head.createDiv({ cls: 'sp-ff-title' });
    this.ffDate = head.createDiv({ cls: 'sp-ff-date' });
    this.surface = root.createDiv({ cls: 'sp-ff-surface', attr: { tabindex: '0' } });
    this.surface.addEventListener('click', (e) => this.onSurfaceClick(e));
    this.surface.addEventListener('keydown', (e) => this.onSurfaceKey(e));
    this.surface.addEventListener('paste', (e) => this.onSurfacePaste(e));
    this.surface.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    this.surface.addEventListener('drop', (e) => this.onSurfaceDrop(e));
    this.addAction('file-text', 'Open as Markdown', () => this.plugin.openAsMarkdown(this.leaf));
  }

  updateHead() {
    if (!this.built || !this.file) return;
    this.ffTitle.setText(this.file.basename);
    const d = new Date(this.file.stat && this.file.stat.ctime ? this.file.stat.ctime : Date.now());
    const day = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    this.ffDate.setText(day + '    ' + time);
  }

  /* ---------------- file <-> view ---------------- */

  setViewData(data, clear) {
    this.build();
    // Obsidian reuses this view for the next note opened in the same tab. A normal note must not
    // be shown (or saved) as boxes: hand the tab back to the normal editor, leaving the file as it is.
    this.foreign = !isFreeformText(data);
    if (this.foreign) {
      this.rawData = data;
      this.boxes = [];
      this.lastBody = null;
      this.localDirty = false;
      this.selected = null;
      this.editing = null;
      this.surface.empty();
      this.ffTitle.setText('');
      this.ffDate.setText('');
      const file = this.file;
      window.setTimeout(() => this.plugin.showInEditor(this.leaf, file), 0);
      return;
    }
    const parts = splitFront(data);
    this.front = parts[0];
    if (clear) {
      this.localDirty = false;
      this.selected = null;
      this.editing = null;
    }
    this.updateHead();
    // The file changed on disk while we hold unsaved box changes (usually just its properties):
    // keep our boxes, take the new properties, and save again.
    if (!clear && this.localDirty) { this.requestSave(); return; }
    if (!clear && parts[1] === this.lastBody) return;
    this.lastBody = parts[1];
    this.boxes = parseBoxes(parts[1]);
    this.renderAll();
  }

  getViewData() {
    if (this.foreign) return this.rawData;
    const body = serializeBoxes(this.boxes);
    this.lastBody = body;
    let front = this.front;
    if (front && !front.endsWith('\n')) front += '\n';
    return front + body;
  }

  clear() {
    this.dropComponents();
    this.front = '';
    this.boxes = [];
    this.lastBody = null;
    this.localDirty = false;
    this.selected = null;
    this.editing = null;
    if (this.surface) this.surface.empty();
  }

  async save(clear) {
    const was = this.localDirty;
    this.localDirty = false;
    try { await super.save(clear); }
    catch (e) { this.localDirty = was; throw e; }
  }

  markDirty() {
    this.localDirty = true;
    this.requestSave();
  }

  /* ---------------- rendering ---------------- */

  dropComponents() {
    for (const b of this.boxes) {
      if (b.comp) { this.removeChild(b.comp); b.comp = null; }
    }
  }

  renderAll() {
    this.surface.empty();
    for (const b of this.boxes) { b.persisted = true; this.addBoxEl(b); }
    this.fitSurface();
  }

  place(box) {
    box.el.style.left = box.x + 'px';
    box.el.style.top = box.y + 'px';
    box.el.style.width = box.w + 'px';
    box.el.style.minHeight = box.h > 0 ? box.h + 'px' : '';
  }

  addBoxEl(box) {
    const el = this.surface.createDiv({ cls: 'sp-ff-box' });
    box.el = el;
    this.place(box);
    const handle = el.createDiv({ cls: 'sp-ff-handle' });
    box.bodyEl = el.createDiv({ cls: 'sp-ff-body markdown-rendered' });
    this.bindDrag(box, handle, 'move');
    this.bindDrag(box, el.createDiv({ cls: 'sp-ff-resize sp-ff-resize-x' }), 'x');
    this.bindDrag(box, el.createDiv({ cls: 'sp-ff-resize sp-ff-resize-y' }), 'y');
    this.bindDrag(box, el.createDiv({ cls: 'sp-ff-resize sp-ff-resize-xy' }), 'xy');
    box.bodyEl.addEventListener('click', (e) => this.onBodyClick(e, box));
    if (box.text) this.renderBox(box);
    return el;
  }

  async renderBox(box) {
    const body = box.bodyEl;
    const src = this.file ? this.file.path : '';
    if (box.comp) this.removeChild(box.comp);
    box.comp = this.addChild(new Component());
    body.empty();
    try {
      if (typeof MarkdownRenderer.render === 'function') await MarkdownRenderer.render(this.app, box.text, body, src, box.comp);
      else await MarkdownRenderer.renderMarkdown(box.text, body, src, box.comp);
    } catch (e) {
      console.error(e);
      body.setText(box.text);
    }
    this.fitSurface();
    window.setTimeout(() => { if (body.isConnected && this.editing !== box) this.fixEmbeds(body, src); }, 200);
  }

  /** Show embedded images that the renderer left as empty placeholders. */
  fixEmbeds(body, src) {
    body.querySelectorAll('.internal-embed').forEach((span) => {
      if (span.querySelector('img, video, audio, .markdown-embed, .markdown-embed-content')) return;
      const link = span.getAttribute('src');
      if (!link) return;
      const target = this.app.metadataCache.getFirstLinkpathDest(link.split('|')[0].split('#')[0], src);
      if (!target || !IMAGE_EXT.includes(String(target.extension).toLowerCase())) return;
      span.empty();
      const img = span.createEl('img');
      img.src = this.app.vault.getResourcePath(target);
      const w = Number(span.getAttribute('width'));
      if (Number.isFinite(w) && w > 0) img.width = w;
      img.addEventListener('load', () => this.fitSurface());
    });
    this.fitSurface();
  }

  fitSurface() {
    if (!this.surface) return;
    let right = 0;
    let bottom = 0;
    for (const b of this.boxes) {
      if (!b.el) continue;
      right = Math.max(right, b.x + b.w);
      bottom = Math.max(bottom, b.y + b.el.offsetHeight);
    }
    this.surface.style.minWidth = (right + 40) + 'px';
    this.surface.style.minHeight = (bottom + 240) + 'px';
  }

  /* ---------------- selecting, editing, removing ---------------- */

  select(box) {
    if (this.selected && this.selected !== box && this.selected.el) this.selected.el.removeClass('is-selected');
    this.selected = box;
    if (box && box.el) box.el.addClass('is-selected');
  }

  removeBox(box) {
    if (box.comp) { this.removeChild(box.comp); box.comp = null; }
    if (box.el) box.el.remove();
    this.boxes = this.boxes.filter((b) => b !== box);
    if (this.selected === box) this.selected = null;
    if (this.editing === box) this.editing = null;
    if (box.persisted) this.markDirty();
    this.fitSurface();
  }

  newBox(x, y, text) {
    const box = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: DEFAULT_BOX_W, h: 0, text: text || '', persisted: false };
    this.boxes.push(box);
    this.addBoxEl(box);
    if (box.text) { box.persisted = true; this.markDirty(); }
    return box;
  }

  nextFreeY() {
    let bottom = 20;
    for (const b of this.boxes) if (b.el) bottom = Math.max(bottom, b.y + b.el.offsetHeight + 24);
    return bottom;
  }

  onSurfaceClick(e) {
    if (e.target !== this.surface || this.foreign) return;
    // Releasing a drag over empty space also reports a click on the page; that is not a request for a new box.
    if (Date.now() < (this.ignoreClickUntil || 0)) return;
    const rect = this.surface.getBoundingClientRect();
    // Offsets put the text caret where the pointer was, allowing for the box padding.
    const box = this.newBox(e.clientX - rect.left - 9, e.clientY - rect.top - 24, '');
    this.startEdit(box);
  }

  onBodyClick(e, box) {
    if (this.editing === box) return;
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) {
      if (a.classList.contains('internal-link')) {
        e.preventDefault();
        const href = a.getAttribute('data-href') || a.getAttribute('href') || '';
        this.app.workspace.openLinkText(href, this.file ? this.file.path : '', Keymap.isModEvent(e));
      }
      return;
    }
    this.startEdit(box);
  }

  startEdit(box) {
    if (this.editing === box) return;
    this.select(box);
    this.editing = box;
    if (box.comp) { this.removeChild(box.comp); box.comp = null; }
    box.el.addClass('is-editing');
    box.bodyEl.empty();
    box.bodyEl.removeClass('markdown-rendered');
    const ta = box.bodyEl.createEl('textarea', { cls: 'sp-ff-edit', attr: { rows: '1', spellcheck: 'true' } });
    ta.value = box.text;
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      this.fitSurface();
    };
    ta.addEventListener('input', () => {
      box.text = ta.value;
      box.persisted = true;
      grow();
      this.markDirty();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
      else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    ta.addEventListener('paste', (e) => this.onPasteInto(e, box, ta));
    ta.addEventListener('click', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => this.endEdit(box));
    grow();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  endEdit(box) {
    if (this.editing !== box) return;
    this.editing = null;
    if (!box.el) return;
    box.el.removeClass('is-editing');
    box.bodyEl.addClass('markdown-rendered');
    if (!box.text.trim()) { this.removeBox(box); return; }
    this.renderBox(box);
  }

  onSurfaceKey(e) {
    if (this.editing || e.target !== this.surface || !this.selected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.removeBox(this.selected);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.startEdit(this.selected);
    }
  }

  /* ---------------- moving and resizing ---------------- */

  bindDrag(box, grabEl, mode) {
    grabEl.addEventListener('click', (e) => e.stopPropagation());
    grabEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.surface.focus({ preventScroll: true }); // ends any edit in progress
      if (!box.el || !box.el.isConnected) return;
      this.select(box);
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = box.x;
      const oy = box.y;
      const ow = box.w;
      const oh = box.el.offsetHeight;
      let moved = false;
      try { grabEl.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      box.el.addClass('is-dragging');
      const move = (ev) => {
        if (!box.el || !box.el.isConnected) return;
        moved = true;
        if (mode === 'move') {
          box.x = Math.max(0, Math.round(ox + ev.clientX - sx));
          box.y = Math.max(0, Math.round(oy + ev.clientY - sy));
        } else {
          if (mode !== 'y') box.w = Math.max(MIN_BOX_W, Math.round(ow + ev.clientX - sx));
          if (mode !== 'x') box.h = Math.max(0, Math.round(oh + ev.clientY - sy));
        }
        this.place(box);
      };
      const up = () => {
        try { grabEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
        grabEl.removeEventListener('pointermove', move);
        grabEl.removeEventListener('pointerup', up);
        grabEl.removeEventListener('pointercancel', up);
        if (box.el) box.el.removeClass('is-dragging');
        this.ignoreClickUntil = Date.now() + 300;
        if (moved && box.el && box.el.isConnected) {
          if (mode !== 'move' && box.h > 0) {
            // A height no taller than the text means "as tall as the text": drop it.
            box.el.style.minHeight = '';
            if (box.h <= box.el.offsetHeight) box.h = 0;
            this.place(box);
          }
          this.markDirty();
          this.fitSurface();
        }
      };
      grabEl.addEventListener('pointermove', move);
      grabEl.addEventListener('pointerup', up);
      grabEl.addEventListener('pointercancel', up);
    });
  }

  /* ---------------- images ---------------- */

  imageFiles(list) {
    return Array.from(list || []).filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));
  }

  async saveImage(f) {
    const buf = await f.arrayBuffer();
    let ext = f.name && f.name.includes('.') ? f.name.split('.').pop() : (f.type.split('/')[1] || 'png');
    ext = String(ext).toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const stamp = window.moment ? window.moment().format('YYYYMMDD-HHmmss') : String(Date.now());
    const name = `${this.file.basename} ${stamp}.${ext}`; // named after the page it was pasted into
    let path;
    if (typeof this.app.fileManager.getAvailablePathForAttachment === 'function') {
      path = await this.app.fileManager.getAvailablePathForAttachment(name, this.file.path);
    } else {
      const dir = this.file.parent && !this.file.parent.isRoot() ? this.file.parent.path + '/' : '';
      path = normalizePath(dir + name);
    }
    const created = await this.app.vault.createBinary(path, buf);
    let link = this.app.fileManager.generateMarkdownLink(created, this.file.path);
    if (!link.startsWith('!')) link = '!' + link;
    return link;
  }

  async onPasteInto(e, box, ta) {
    const images = this.imageFiles(e.clipboardData && e.clipboardData.files);
    if (!images.length) return; // plain text pastes normally
    e.preventDefault();
    for (const f of images) {
      let link;
      try { link = await this.saveImage(f); }
      catch (err) { console.error(err); new Notice('Could not save the image.'); continue; }
      if (this.editing === box && ta.isConnected) {
        ta.setRangeText(link + '\n', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      } else if (box.el && box.el.isConnected) {
        box.text = (box.text ? box.text + '\n' : '') + link;
        box.persisted = true;
        this.markDirty();
        this.renderBox(box);
      } else {
        this.newBox(40, this.nextFreeY(), link);
      }
    }
  }

  async addImagesAt(images, x, y) {
    let top = y;
    for (const f of images) {
      try {
        const link = await this.saveImage(f);
        const box = this.newBox(x, top, link);
        top += 40;
        this.select(box);
      } catch (err) {
        console.error(err);
        new Notice('Could not save the image.');
      }
    }
  }

  onSurfacePaste(e) {
    if (this.editing || this.foreign) return;
    const images = this.imageFiles(e.clipboardData && e.clipboardData.files);
    if (images.length) {
      e.preventDefault();
      this.addImagesAt(images, 40, this.nextFreeY());
      return;
    }
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (text && text.trim()) {
      e.preventDefault();
      this.select(this.newBox(40, this.nextFreeY(), text));
    }
  }

  onSurfaceDrop(e) {
    if (this.foreign) return;
    const images = this.imageFiles(e.dataTransfer && e.dataTransfer.files);
    if (!images.length) return;
    e.preventDefault();
    const rect = this.surface.getBoundingClientRect();
    this.addImagesAt(images, e.clientX - rect.left, e.clientY - rect.top);
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class SectionPagesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Root folder')
      .setDesc('Folder whose subfolders become sections. Leave empty to use the whole vault.')
      .addText((t) => t.setPlaceholder('e.g. Notebook').setValue(this.plugin.data.rootFolder).onChange(async (v) => {
        this.plugin.data.rootFolder = v.trim();
        await this.plugin.saveData(this.plugin.data);
        this.plugin.refreshViews();
      }));
    new Setting(containerEl)
      .setName('Attachments folder name')
      .setDesc('Folders with this name are hidden from the section list. Match it to Obsidian\'s "Default location for new attachments" subfolder name.')
      .addText((t) => t.setPlaceholder('assets').setValue(this.plugin.data.attachmentsFolder).onChange(async (v) => {
        this.plugin.data.attachmentsFolder = v.trim();
        await this.plugin.saveData(this.plugin.data);
        this.plugin.refreshViews();
      }));
  }
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

class SectionPagesPlugin extends Plugin {
  async onload() {
    this.data = Object.assign({}, DEFAULT_DATA, (await this.loadData()) || {});
    for (const k of ['lastPage', 'collapsedPages', 'collapsedGroups', 'groups', 'colors']) {
      if (!this.data[k] || typeof this.data[k] !== 'object') this.data[k] = {};
    }
    this.overrides = new Map(); // path -> {order, level}, shown until the metadata cache catches up
    this.saveSoon = debounce(() => this.saveData(this.data), 400, true);
    this.refreshViews = debounce(() => this.renderAll(), 50, true);

    this.asMarkdown = new WeakMap(); // tab -> path of a freeform page the user chose to see as Markdown
    this.backButtons = new WeakMap(); // editor view -> its "Open as freeform page" header button
    this.currentPath = null;

    this.registerView(VIEW_TYPE, (leaf) => new NavView(leaf, this));
    this.registerView(FREEFORM_VIEW, (leaf) => new FreeformView(leaf, this));
    this.addRibbonIcon('book-open', 'Open sections and pages', () => this.activateView());
    this.addSettingTab(new SectionPagesSettingTab(this.app, this));

    this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => this.activateView() });
    this.addCommand({
      id: 'new-page', name: 'New page in current section',
      callback: () => this.newPage(this.getActiveSection(), null),
    });
    this.addCommand({
      id: 'new-freeform-page', name: 'New freeform page in current section',
      callback: () => this.newPage(this.getActiveSection(), null, true),
    });
    this.addCommand({
      id: 'toggle-freeform-markdown', name: 'Switch this page between freeform and Markdown view',
      checkCallback: (checking) => this.toggleFreeformView(checking),
    });
    this.addCommand({
      id: 'convert-to-freeform', name: 'Convert this page to a freeform page',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md' || this.isFreeform(file)) return false;
        if (!checking) this.convertToFreeform(file);
        return true;
      },
    });
    this.addCommand({
      id: 'convert-to-normal', name: 'Convert this freeform page to a normal page',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md' || !this.isFreeform(file)) return false;
        if (!checking) this.convertToNormal(file);
        return true;
      },
    });
    this.addCommand({
      id: 'make-subpage', name: 'Make subpage',
      checkCallback: (checking) => this.indentActive(checking, 1),
    });
    this.addCommand({
      id: 'promote-subpage', name: 'Promote subpage',
      checkCallback: (checking) => this.indentActive(checking, -1),
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', () => this.refreshViews()));
      this.registerEvent(this.app.vault.on('delete', () => this.refreshViews()));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
      this.registerEvent(this.app.metadataCache.on('changed', (file) => this.onMetaChanged(file)));
      this.registerEvent(this.app.workspace.on('file-open', (file) => this.onFileOpen(file)));
      this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.checkFreeformLeaves()));
      this.registerEvent(this.app.workspace.on('layout-change', () => this.checkFreeformLeaves()));
      this.checkFreeformLeaves();
      this.refreshViews();
    });
  }

  onunload() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const el = this.backButtons ? this.backButtons.get(leaf.view) : null;
      if (el) el.remove();
    });
  }

  async activateView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeftLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
  }

  renderAll() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof NavView) leaf.view.render();
    }
  }

  /* ---------------- freeform pages ---------------- */

  activePath() {
    if (this.currentPath) return this.currentPath;
    const f = this.app.workspace.getActiveFile();
    return f ? f.path : null;
  }

  isFreeform(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    return !!(cache && cache.frontmatter && cache.frontmatter[TYPE_KEY] === FREEFORM);
  }

  /** Any tab showing a freeform page in the normal editor is switched to the freeform view. */
  checkFreeformLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!(v instanceof MarkdownView)) return;
      const path = v.file ? v.file.path : null;
      const chosen = this.asMarkdown.get(leaf);
      // "Open as Markdown" lasts until the tab shows another page.
      if (chosen && chosen !== path) this.asMarkdown.delete(leaf);
      const freeform = !!v.file && this.isFreeform(v.file);
      this.syncBackButton(leaf, v, freeform && chosen === path);
      if (!freeform || chosen === path) return;
      const vs = leaf.getViewState();
      leaf.setViewState({ type: FREEFORM_VIEW, state: { file: v.file.path }, active: vs.active, pinned: vs.pinned });
    });
  }

  /** Show a normal note in the normal editor when its tab currently holds the freeform view. */
  showInEditor(leaf, file) {
    if (!leaf || !file || !(leaf.view instanceof FreeformView) || leaf.view.file !== file) return;
    const vs = leaf.getViewState();
    return leaf.setViewState({ type: 'markdown', state: { file: file.path }, active: vs.active, pinned: vs.pinned });
  }

  /** Header button on the normal editor that returns a freeform page to its freeform view. */
  syncBackButton(leaf, view, show) {
    const existing = this.backButtons.get(view);
    if (show && !existing) {
      const el = view.addAction('layout-dashboard', 'Open as freeform page', () => this.openAsFreeform(leaf));
      el.addClass('sp-ff-back');
      this.backButtons.set(view, el);
    } else if (!show && existing) {
      existing.remove();
      this.backButtons.delete(view);
    }
  }

  openAsFreeform(leaf) {
    this.asMarkdown.delete(leaf);
    this.checkFreeformLeaves();
  }

  openAsMarkdown(leaf) {
    const v = leaf && leaf.view;
    if (!v || !v.file) return;
    this.asMarkdown.set(leaf, v.file.path);
    return leaf.setViewState({ type: 'markdown', state: { file: v.file.path }, active: true })
      .then(() => this.checkFreeformLeaves());
  }

  toggleFreeformView(checking) {
    const leaf = this.app.workspace.getMostRecentLeaf ? this.app.workspace.getMostRecentLeaf() : this.app.workspace.activeLeaf;
    const v = leaf && leaf.view;
    if (!v || !v.file) return false;
    if (v instanceof FreeformView) {
      if (!checking) this.openAsMarkdown(leaf);
      return true;
    }
    if (v instanceof MarkdownView && this.isFreeform(v.file)) {
      if (!checking) this.openAsFreeform(leaf);
      return true;
    }
    return false;
  }

  async convertToFreeform(file) {
    try {
      // Existing text becomes one box; the view picks that up when it opens the file.
      await this.app.fileManager.processFrontMatter(file, (fm) => { fm[TYPE_KEY] = FREEFORM; });
    } catch (e) {
      console.error(e);
      new Notice('Could not convert the page.');
    }
  }

  async convertToNormal(file) {
    const leaves = this.app.workspace.getLeavesOfType(FREEFORM_VIEW).filter((l) => l.view && l.view.file === file);
    try {
      for (const leaf of leaves) {
        await leaf.view.save();
        this.asMarkdown.set(leaf, file.path);
        await leaf.setViewState({ type: 'markdown', state: { file: file.path }, active: true });
      }
      await this.app.vault.process(file, (data) => {
        const parts = splitFront(data);
        let front = parts[0];
        if (front && !front.endsWith('\n')) front += '\n';
        return front + stripBoxMarkers(parts[1]);
      });
      await this.app.fileManager.processFrontMatter(file, (fm) => { delete fm[TYPE_KEY]; });
    } catch (e) {
      console.error(e);
      new Notice('Could not convert the page.');
    }
    for (const leaf of leaves) this.asMarkdown.delete(leaf);
    this.refreshViews();
  }

  /* ---------------- folders and sections ---------------- */

  folderByPath(p) {
    if (p === null || p === undefined) return null;
    if (p === '/' || p === '') return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFolder ? f : null;
  }

  getRoot() {
    const p = (this.data.rootFolder || '').trim();
    if (!p) return this.app.vault.getRoot();
    return this.folderByPath(normalizePath(p));
  }

  joinPath(folder, name) {
    return folder.isRoot() ? name : folder.path + '/' + name;
  }

  isHiddenFolder(folder) {
    return folder.name.startsWith('.') || (!!this.data.attachmentsFolder && folder.name === this.data.attachmentsFolder);
  }

  childFolders(folder) {
    return folder.children
      .filter((c) => c instanceof TFolder && !this.isHiddenFolder(c))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  hasNotes(folder) {
    return folder.children.some((c) => c instanceof TFile && c.extension === 'md');
  }

  isUnderRoot(folder) {
    const root = this.getRoot();
    if (!root) return false;
    if (root.isRoot()) return true;
    return folder.path === root.path || folder.path.startsWith(root.path + '/');
  }

  getActiveSection() {
    const root = this.getRoot();
    if (!root) return null;
    const saved = this.folderByPath(this.data.activeSection);
    if (saved && this.isUnderRoot(saved)) return saved;
    // Fall back to the first folder that has notes.
    const find = (folder) => {
      for (const f of this.childFolders(folder)) {
        if (this.hasNotes(f)) return f;
        const deeper = find(f);
        if (deeper) return deeper;
      }
      return null;
    };
    if (this.hasNotes(root)) return root;
    return find(root) || this.childFolders(root)[0] || null;
  }

  colorFor(path) {
    if (!this.data.colors[path]) {
      this.data.colors[path] = PALETTE[this.data.colorCursor % PALETTE.length].value;
      this.data.colorCursor = (this.data.colorCursor + 1) % PALETTE.length;
      this.saveSoon();
    }
    return this.data.colors[path];
  }

  selectSection(path, openLast) {
    this.data.activeSection = path;
    this.saveSoon();
    const folder = this.folderByPath(path);
    if (openLast && folder) {
      const last = this.app.vault.getAbstractFileByPath(this.data.lastPage[path] || '');
      const pages = this.pagesOf(folder);
      const file = last instanceof TFile && last.parent === folder ? last : (pages[0] ? pages[0].file : null);
      if (file) this.openPage(file, false);
    }
    this.refreshViews();
  }

  async newSection(parent) {
    if (!parent) return;
    const name = await promptText(this.app, 'New section', 'New Section');
    if (name === null) return;
    if (!validName(name)) { new Notice('That name is empty or has characters that are not allowed.'); return; }
    const path = this.joinPath(parent, name);
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('A section with that name already exists.'); return; }
    try {
      await this.app.vault.createFolder(path);
      delete this.data.collapsedGroups[parent.path];
      this.selectSection(path, false);
    } catch (e) {
      console.error(e);
      new Notice('Could not create the section.');
    }
  }

  /** A group holds sections and has no pages of its own. */
  isGroup(folder) {
    if (this.hasNotes(folder)) return false;
    return !!this.data.groups[folder.path] || this.childFolders(folder).length > 0;
  }

  async newGroup(parent) {
    if (!parent) return;
    const name = await promptText(this.app, 'New group', 'New Group');
    if (name === null) return;
    if (!validName(name)) { new Notice('That name is empty or has characters that are not allowed.'); return; }
    const path = this.joinPath(parent, name);
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('Something with that name already exists here.'); return; }
    try {
      await this.app.vault.createFolder(path);
      this.data.groups[path] = true;
      delete this.data.collapsedGroups[parent.path];
      this.saveSoon();
    } catch (e) {
      console.error(e);
      new Notice('Could not create the group.');
    }
    this.refreshViews();
  }

  canMoveSection(srcPath, target) {
    const src = this.folderByPath(srcPath);
    if (!src || !target || src.isRoot()) return false;
    if (src === target || src.parent === target) return false;
    // Not into itself or something inside it.
    if (!target.isRoot() && (target.path + '/').startsWith(src.path + '/')) return false;
    return true;
  }

  async moveSection(srcPath, target) {
    if (!this.canMoveSection(srcPath, target)) return;
    const src = this.folderByPath(srcPath);
    const dest = this.joinPath(target, src.name);
    if (this.app.vault.getAbstractFileByPath(dest)) {
      new Notice(`"${src.name}" already exists there. Nothing was moved.`);
      return;
    }
    try {
      await this.app.fileManager.renameFile(src, dest);
      delete this.data.collapsedGroups[target.path];
      this.saveSoon();
    } catch (e) {
      console.error(e);
      new Notice('Could not move it.');
    }
    this.refreshViews();
  }

  async renameSection(folder) {
    const name = await promptText(this.app, 'Rename section', folder.name);
    if (name === null || name === folder.name) return;
    if (!validName(name)) { new Notice('That name is empty or has characters that are not allowed.'); return; }
    const parent = folder.parent;
    const path = parent ? this.joinPath(parent, name) : name;
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('A section with that name already exists.'); return; }
    try { await this.app.fileManager.renameFile(folder, path); }
    catch (e) { console.error(e); new Notice('Could not rename the section.'); }
  }

  async deleteSection(folder) {
    const yes = await confirmDelete(this.app, `Delete the section "${folder.name}" and everything in it? It goes to the trash.`);
    if (yes) await this.trash(folder);
  }

  async trash(file) {
    try {
      if (typeof this.app.fileManager.trashFile === 'function') await this.app.fileManager.trashFile(file);
      else await this.app.vault.trash(file, true);
    } catch (e) {
      console.error(e);
      new Notice('Could not delete.');
    }
  }

  /* ---------------- pages ---------------- */

  getMeta(file) {
    const ov = this.overrides.get(file.path);
    if (ov) return ov;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache && cache.frontmatter ? cache.frontmatter : null;
    return {
      order: toNum(fm ? fm[ORDER_KEY] : undefined),
      level: clampLevel(fm ? fm[LEVEL_KEY] : 0),
    };
  }

  pagesOf(folder) {
    const items = [];
    for (const c of folder.children) {
      if (c instanceof TFile && c.extension === 'md') {
        const m = this.getMeta(c);
        items.push({ file: c, path: c.path, name: c.basename, order: m.order, level: m.level });
      }
    }
    return sortPages(items);
  }

  async openPage(file, focus, forceFreeform) {
    const leaf = this.app.workspace.getLeaf(false);
    if (!leaf) return;
    this.currentPath = file.path;
    if (file.parent) {
      this.data.lastPage[file.parent.path] = file.path;
      this.saveSoon();
    }
    try {
      if ((forceFreeform || this.isFreeform(file)) && this.asMarkdown.get(leaf) !== file.path) {
        await leaf.setViewState({ type: FREEFORM_VIEW, state: { file: file.path }, active: !!focus });
      } else if (leaf.view instanceof FreeformView) {
        // openFile would reuse the freeform view for this normal note.
        await leaf.setViewState({ type: 'markdown', state: { file: file.path }, active: !!focus });
      } else {
        await leaf.openFile(file, { active: !!focus });
      }
    } catch (e) { console.error(e); }
    this.refreshViews();
  }

  /**
   * Write the final sequence to the notes. `seq` items carry the current order/level and an
   * optional newLevel. Only notes whose values actually change are touched.
   */
  async applySequence(seq, moved) {
    const orders = planOrders(seq.map((s) => ({ path: s.path, order: s.order })), moved);
    const writes = [];
    seq.forEach((s, i) => {
      const newLevel = s.newLevel === undefined ? s.level : s.newLevel;
      if (orders[i] !== s.order || newLevel !== s.level) {
        writes.push({ file: s.file, order: orders[i], level: newLevel });
      }
    });
    for (const w of writes) this.overrides.set(w.file.path, { order: w.order, level: w.level });
    this.refreshViews();
    for (const w of writes) {
      try {
        await this.app.fileManager.processFrontMatter(w.file, (fm) => {
          fm[ORDER_KEY] = w.order;
          if (w.level > 0) fm[LEVEL_KEY] = w.level;
          else delete fm[LEVEL_KEY];
        });
      } catch (e) {
        console.error(e);
        this.overrides.delete(w.file.path);
        new Notice(`Could not update "${w.file.basename}".`);
      }
    }
    this.refreshViews();
  }

  async indentPage(folder, path, delta) {
    const items = this.pagesOf(folder);
    const levels = effectiveLevels(items);
    const i = items.findIndex((x) => x.path === path);
    if (i < 0) return;
    if (delta > 0) {
      if (i === 0 || levels[i] >= MAX_LEVEL || levels[i] > levels[i - 1]) return;
    } else if (levels[i] === 0) {
      return;
    }
    const end = subtreeEnd(levels, i);
    const seq = items.map((it, k) => Object.assign({}, it, {
      newLevel: k >= i && k < end ? clampLevel(levels[k] + delta) : it.level,
    }));
    await this.applySequence(seq, new Set());
  }

  indentActive(checking, delta) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md' || !file.parent) return false;
    if (!checking) this.indentPage(file.parent, file.path, delta);
    return true;
  }

  async movePage(folder, srcPath, targetPath, where) {
    const items = this.pagesOf(folder);
    const levels = effectiveLevels(items);
    const si = items.findIndex((x) => x.path === srcPath);
    const ti = items.findIndex((x) => x.path === targetPath);
    if (si < 0 || ti < 0) return;
    const se = subtreeEnd(levels, si);
    if (ti >= si && ti < se) return; // cannot drop a page into its own subpages
    const tagged = items.map((it, k) => Object.assign({}, it, { eff: levels[k], newLevel: it.level }));
    const block = tagged.slice(si, se);
    const rest = tagged.slice(0, si).concat(tagged.slice(se));
    const rti = rest.findIndex((x) => x.path === targetPath);
    const insertAt = where === 'before' ? rti : subtreeEnd(rest.map((x) => x.eff), rti);
    const delta = levels[ti] - levels[si];
    for (const b of block) b.newLevel = clampLevel(b.eff + delta);
    const seq = rest.slice(0, insertAt).concat(block, rest.slice(insertAt));
    await this.applySequence(seq, new Set(block.map((b) => b.path)));
  }

  /** Move a page (with its subpages) to the end of another section. */
  async movePageToSection(srcPath, target) {
    const src = this.app.vault.getAbstractFileByPath(srcPath);
    if (!(src instanceof TFile) || !src.parent || src.parent === target) return;
    const items = this.pagesOf(src.parent);
    const levels = effectiveLevels(items);
    const si = items.findIndex((x) => x.path === srcPath);
    if (si < 0) return;
    const block = items.slice(si, subtreeEnd(levels, si)).map((it, k) => ({ it, eff: levels[si + k] }));
    for (const b of block) {
      if (this.app.vault.getAbstractFileByPath(this.joinPath(target, b.it.file.name))) {
        new Notice(`"${b.it.name}" already exists in "${target.name}". Nothing was moved.`);
        return;
      }
    }
    const existing = this.pagesOf(target);
    try {
      for (const b of block) await this.app.fileManager.renameFile(b.it.file, this.joinPath(target, b.it.file.name));
    } catch (e) {
      console.error(e);
      new Notice('Could not move the page.');
      return;
    }
    const moved = block.map((b) => ({
      file: b.it.file, path: b.it.file.path, name: b.it.name,
      order: NaN, level: b.it.level, newLevel: clampLevel(b.eff - levels[si]),
    }));
    await this.applySequence(existing.concat(moved), new Set(moved.map((m) => m.path)));
  }

  /**
   * afterPath: the page the new one goes after, at the same level and below its subpages.
   * asChild: make it a subpage of that page instead, placed after the existing subpages.
   */
  async newPage(folder, afterPath, freeform, asChild) {
    if (!folder) { new Notice('Select or create a section first.'); return; }
    const name = await promptText(this.app, freeform ? 'New freeform page' : 'New page', 'Untitled Page');
    if (name === null) return;
    if (!validName(name)) { new Notice('That name is empty or has characters that are not allowed.'); return; }
    const path = this.joinPath(folder, name + '.md');
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('A page with that name already exists in this section.'); return; }

    const items = this.pagesOf(folder);
    const levels = effectiveLevels(items);
    const idx = afterPath ? items.findIndex((x) => x.path === afterPath) : -1;
    const level = idx >= 0 ? Math.min(MAX_LEVEL, levels[idx] + (asChild ? 1 : 0)) : 0;
    const insertAt = idx >= 0 ? subtreeEnd(levels, idx) : items.length;
    if (asChild && idx >= 0 && this.data.collapsedPages[afterPath]) {
      delete this.data.collapsedPages[afterPath]; // show the new subpage
      this.saveSoon();
    }

    let file;
    try { file = await this.app.vault.create(path, freeform ? `---\n${TYPE_KEY}: ${FREEFORM}\n---\n` : ''); }
    catch (e) { console.error(e); new Notice('Could not create the page.'); return; }

    const fresh = { file, path: file.path, name: file.basename, order: NaN, level: 0, newLevel: level };
    const seq = items.slice(0, insertAt).concat([fresh], items.slice(insertAt));
    await this.applySequence(seq, new Set([file.path]));
    this.data.activeSection = folder.path;
    this.openPage(file, true, !!freeform);
    this.refreshViews();
  }

  async renamePage(file) {
    const name = await promptText(this.app, 'Rename page', file.basename);
    if (name === null || name === file.basename) return;
    if (!validName(name)) { new Notice('That name is empty or has characters that are not allowed.'); return; }
    const path = this.joinPath(file.parent, name + '.' + file.extension);
    if (this.app.vault.getAbstractFileByPath(path)) { new Notice('A page with that name already exists in this section.'); return; }
    try { await this.app.fileManager.renameFile(file, path); }
    catch (e) { console.error(e); new Notice('Could not rename the page.'); }
  }

  /* ---------------- events ---------------- */

  onRename(file, oldPath) {
    const d = this.data;
    const newPath = file.path;
    d.activeSection = remapPath(d.activeSection, oldPath, newPath);
    d.collapsedPages = remapKeys(d.collapsedPages, oldPath, newPath);
    d.collapsedGroups = remapKeys(d.collapsedGroups, oldPath, newPath);
    d.groups = remapKeys(d.groups, oldPath, newPath);
    d.colors = remapKeys(d.colors, oldPath, newPath);
    const last = {};
    for (const k of Object.keys(d.lastPage)) {
      last[remapPath(k, oldPath, newPath)] = remapPath(d.lastPage[k], oldPath, newPath);
    }
    d.lastPage = last;
    this.currentPath = remapPath(this.currentPath, oldPath, newPath);
    for (const leaf of this.app.workspace.getLeavesOfType(FREEFORM_VIEW)) {
      if (leaf.view instanceof FreeformView) leaf.view.updateHead();
    }
    this.overrides.delete(oldPath);
    this.saveSoon();
    this.refreshViews();
  }

  onMetaChanged(file) {
    const ov = this.overrides.get(file.path);
    if (ov) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache && cache.frontmatter ? cache.frontmatter : null;
      const order = toNum(fm ? fm[ORDER_KEY] : undefined);
      const level = clampLevel(fm ? fm[LEVEL_KEY] : 0);
      if (order === ov.order && level === ov.level) this.overrides.delete(file.path);
    }
    this.checkFreeformLeaves();
    this.refreshViews();
  }

  onFileOpen(file) {
    this.currentPath = file ? file.path : null;
    this.checkFreeformLeaves();
    if (file && file.extension === 'md' && file.parent
        && this.isUnderRoot(file.parent) && !this.isHiddenFolder(file.parent)) {
      this.data.activeSection = file.parent.path;
      this.data.lastPage[file.parent.path] = file.path;
      this.saveSoon();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof NavView) leaf.view.kbPath = file.path;
      }
    }
    this.refreshViews();
  }
}

module.exports = SectionPagesPlugin;
module.exports._logic = {
  sortPages, effectiveLevels, subtreeEnd, planOrders, remapPath, clampLevel, toNum, validName,
  splitFront, parseBoxes, serializeBoxes, stripBoxMarkers, isFreeformText,
};
