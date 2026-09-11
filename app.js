/* DiaCab — server cabinet diagram builder.
   No dependencies, no build step.

   State shape:
     { numberFromTop,
       racks: [{ id, name, u, maxW, x, y, devices: [{id,type,u,pos,label,sub,color,idle,peak}] }],
       activeRackId, selectedId }
   `pos` is the 1-based rack unit of a device's BOTTOM edge, independent of which way the
   rails are numbered. `x`/`y` are the cabinet's position on the canvas in GRID units.
   Device ids are unique across all cabinets.
   Every mutation goes through commit(), which records undo history, persists, re-renders. */

'use strict';

/* ─────────────────────────── model ─────────────────────────── */

let UH = 26;                         // px per rack unit; kept in sync with the --uh CSS var
const GRID = 24;                     // canvas grid step in px; mirrors --grid in styles.css
const CANVAS_PAD = 40;               // slack kept to the right of / below the last cabinet
let cabStep = 20;                    // cabinet pitch in grid units, re-measured on render
const STORE_KEY = 'diacab:v2';
const LEGACY_KEY = 'diacab:v1';      // single-cabinet format, migrated on first load
const ZOOM_KEY = 'diacab:zoom';      // a view preference, deliberately outside the diagram

const SERVER_HEIGHTS = Array.from({ length: 20 }, (_, i) => i + 1);   // 1U – 20U

const TYPES = {
  server:   { name: 'Server',   plural: 'Servers',   tag: 'srv', heights: SERVER_HEIGHTS, color: '#4c8dff' },
  switch:   { name: 'Switch',   plural: 'Switches',  tag: 'sw',  heights: [1, 2],         color: '#2ec27e' },
  firewall: { name: 'Firewall', plural: 'Firewalls', tag: 'fw',  heights: [1, 2],         color: '#f5a524' },
};

const COLORS = ['#4c8dff', '#2ec27e', '#f5a524', '#e5534b', '#a371f7',
                '#25c2d6', '#ec6cb9', '#9aa4b2'];

/* Default idle→peak draw in watts, by type and size. Starting points only: every device
   carries its own editable range. */
const POWER = {
  server:   (u) => ({ idle: 120 + 60 * (u - 1), peak: 350 + 150 * (u - 1) }),
  switch:   (u) => ({ idle: 60 * u, peak: 150 * u }),
  firewall: (u) => ({ idle: 45 * u, peak: 120 * u }),
};
const DEFAULT_MAX_W = 5000;          // per-cabinet power budget, 0 = no limit
const MAX_DEVICE_W = 30000;
const MAX_RACK_W = 100000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** "450 W" / "3.4 kW" / "—" for no limit. */
function fmtW(w) {
  if (!w) return '—';
  if (w < 1000) return `${w} W`;
  const k = w / 1000;
  return `${k % 1 === 0 ? k : k.toFixed(1)} kW`;
}

/** "120–350 W" / "1.2–3.4 kW" */
function fmtRange(a, b) {
  if (!a && !b) return '0 W';
  if (b >= 1000) return `${(a / 1000).toFixed(1)}–${(b / 1000).toFixed(1)} kW`;
  return `${a}–${b} W`;
}

function rackPower(rack) {
  return rack.devices.reduce((acc, d) => ({ idle: acc.idle + d.idle, peak: acc.peak + d.peak }),
                             { idle: 0, peak: 0 });
}
const isOverBudget = (rack) => rack.maxW > 0 && rackPower(rack).peak > rack.maxW;

let uid = 1;
const nextId = (prefix) => prefix + (uid++);

function newRack(name, u, maxW, x, y) {
  return {
    id: nextId('r'),
    name,
    u: u || 42,
    maxW: maxW === undefined ? DEFAULT_MAX_W : maxW,
    x: x || 0,
    y: y || 0,
    devices: [],
  };
}

function blankState() {
  const rack = newRack('Cabinet A', 42);
  return { numberFromTop: false, racks: [rack], activeRackId: rack.id, selectedId: null };
}

let state = blankState();
let undoStack = [];
let redoStack = [];

/* ─────────────────────────── dom ─────────────────────────── */

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), canvas: $('canvas'),
  cabName: $('cabName'), cabU: $('cabU'),
  numTop: $('numTop'), zoom: $('zoom'),
  inspector: $('inspector'), inspectorEmpty: $('inspectorEmpty'),
  fLabel: $('fLabel'), fSub: $('fSub'), fCab: $('fCab'), fType: $('fType'),
  fIdle: $('fIdle'), fPeak: $('fPeak'), cabW: $('cabW'),
  fHeight: $('fHeight'), fPos: $('fPos'), fSwatches: $('fSwatches'),
  stats: $('stats'), toast: $('toast'),
  btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnDelCab: $('btnDelCab'),
};

/** Preview mode: chrome hidden, cabinets only, all editing inert. A view flag, so it is
    deliberately kept out of `state` and out of undo history. */
let preview = false;

/** The floating drop indicator, re-parented into whichever cabinet is targeted. */
const placement = document.createElement('div');
placement.className = 'placement';
placement.hidden = true;

/* ─────────────────────────── lookups ─────────────────────────── */

const rackById = (id) => state.racks.find((r) => r.id === id) || null;
const rackIndex = (id) => state.racks.findIndex((r) => r.id === id);

/** Cabinets in reading order — left to right, then top to bottom. Used everywhere the
    user sees a list or sequence, so it follows what's on the canvas, not insertion order. */
const orderedRacks = () => [...state.racks].sort((a, b) => a.x - b.x || a.y - b.y);

/** The first free column to the right of everything, in grid units. */
function freeColumn() {
  if (!state.racks.length) return 0;
  return Math.max(...state.racks.map((r) => r.x)) + cabStep;
}

function activeRack() {
  return rackById(state.activeRackId) || state.racks[0] || null;
}

/** Locate a device anywhere in the diagram: { rack, dev } or null. */
function findDevice(id) {
  for (const rack of state.racks) {
    const dev = rack.devices.find((d) => d.id === id);
    if (dev) return { rack, dev };
  }
  return null;
}
const selectedPair = () => (state.selectedId ? findDevice(state.selectedId) : null);
const allDevices = () => state.racks.flatMap((r) => r.devices);

/** true when `u` units starting at 0-based `start` fit in `rack` with nothing in the way. */
function fits(rack, start, u, ignoreId) {
  if (start < 0 || start + u > rack.u) return false;
  for (const d of rack.devices) {
    if (d.id === ignoreId) continue;
    const a = d.pos - 1, b = a + d.u;
    if (start < b && a < start + u) return false;
  }
  return true;
}

function lowestFreeStart(rack, u, ignoreId) {
  for (let i = 0; i <= rack.u - u; i++) if (fits(rack, i, u, ignoreId)) return i;
  return -1;
}

/** U number printed on the rails for a 0-based slot index counted from the bottom. */
const uNumberAt = (rack, i) => (state.numberFromTop ? rack.u - i : i + 1);

/** The U number shown for a device: the smallest printed label it covers. */
function displayU(rack, d) {
  return state.numberFromTop ? rack.u - (d.pos - 1 + d.u) + 1 : d.pos;
}
function posFromDisplayU(rack, value, u) {
  return state.numberFromTop ? rack.u - u + 2 - value : value;
}

function defaultLabel(type) {
  const n = allDevices().filter((d) => d.type === type).length + 1;
  const pad = String(n).padStart(2, '0');
  if (type === 'server') return `srv-${pad}`;
  if (type === 'switch') return `sw-${pad}`;
  return `fw-${pad}`;
}

/** Name for a copy of a device labelled `from`:
      "spine-01" → "spine-02"   (trailing number increments, zero-padding kept)
      "core-sw"  → "core-sw copy"
      "core-sw copy" → "core-sw copy 1"  (already ends in "copy", so number it)
    Each candidate skips labels already in use anywhere in the diagram. */
function nextDeviceLabel(from) {
  const taken = (label) => allDevices().some((d) => d.label === label);
  const free = (make) => {
    for (let n = 1; n <= 999; n++) {
      const candidate = make(n);
      if (!taken(candidate)) return candidate;
    }
    return null;
  };

  const trailing = from.match(/^(.*?)(\d+)$/);
  if (trailing) {
    const [, stem, digits] = trailing;
    const start = parseInt(digits, 10);
    const width = digits.length;
    const found = free((n) => stem + String(start + n).padStart(width, '0'));
    if (found) return found;
  }

  if (/copy$/i.test(from)) return free((n) => `${from} ${n}`) || `${from} 1`;

  if (!taken(`${from} copy`)) return `${from} copy`;
  return free((n) => `${from} copy ${n}`) || `${from} copy`;
}

/** "Cabinet A" → the first free "Cabinet B/C/…"; "rack-3" → "rack-4"; otherwise " copy". */
function nextCabinetName(from) {
  const taken = (name) => state.racks.some((r) => r.name === name);
  const letter = from.match(/^(.*?)([A-Z])$/);
  if (letter) {
    for (let c = letter[2].charCodeAt(0) + 1; c <= 'Z'.charCodeAt(0); c++) {
      const candidate = letter[1] + String.fromCharCode(c);
      if (!taken(candidate)) return candidate;
    }
  }
  const num = from.match(/^(.*?)(\d+)$/);
  if (num) {
    const width = num[2].length;
    for (let n = parseInt(num[2], 10) + 1; n < parseInt(num[2], 10) + 50; n++) {
      const candidate = num[1] + String(n).padStart(width, '0');
      if (!taken(candidate)) return candidate;
    }
  }
  let candidate = from + ' copy', i = 2;
  while (taken(candidate)) candidate = `${from} copy ${i++}`;
  return candidate;
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

/* ─────────────────────────── history + persistence ─────────────────────────── */

const snapshot = () => JSON.stringify(state);

function commit(mutate) {
  const before = snapshot();
  const overBefore = new Set(state.racks.filter(isOverBudget).map((r) => r.id));
  const result = mutate();
  if (snapshot() === before) return result;      // no-op, keep history clean
  undoStack.push(before);
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  save();
  render();

  // power is a budget, not a hard constraint: allow it, but say so once it's exceeded
  const newlyOver = state.racks.filter((r) => isOverBudget(r) && !overBefore.has(r.id));
  if (newlyOver.length) {
    const r = newlyOver[0];
    toast(`${r.name} is over budget: peak ${fmtW(rackPower(r).peak)} of ${fmtW(r.maxW)}.`);
  }
  return result;
}

function restore(json) {
  state = JSON.parse(json);
  bumpUid();
  save();
  render();
}

function bumpUid() {
  const ids = [...state.racks.map((r) => r.id), ...allDevices().map((d) => d.id)];
  uid = Math.max(uid, ...ids.map((id) => parseInt(String(id).slice(1), 10) || 0)) + 1;
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function save() {
  try { localStorage.setItem(STORE_KEY, snapshot()); } catch (_) { /* private mode */ }
}

function load() {
  let raw = null, legacy = false;
  try {
    raw = localStorage.getItem(STORE_KEY);
    if (!raw) { raw = localStorage.getItem(LEGACY_KEY); legacy = !!raw; }
  } catch (_) { return false; }
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    state = normalize(parsed);
    bumpUid();
    if (legacy) save();                           // migrate forward, keep the old key alone
    return true;
  } catch (_) { return false; }
}

/** Coerce arbitrary/imported JSON (v1 single-cabinet or v2 multi-cabinet) into valid state. */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a diagram');

  // v1: { rack: {...}, devices: [...] }  →  one cabinet
  const rawRacks = Array.isArray(raw.racks) ? raw.racks
    : (raw.rack ? [{ ...raw.rack, devices: raw.devices }] : null);
  if (!rawRacks || !rawRacks.length) throw new Error('no cabinets');

  const s = { numberFromTop: !!(raw.numberFromTop ?? (raw.rack && raw.rack.numberFromTop)),
              racks: [], activeRackId: null, selectedId: null };

  for (const [i, rr] of rawRacks.entries()) {
    if (!rr || typeof rr !== 'object') continue;
    const rack = {
      id: nextId('r'),
      name: String(rr.name ?? 'Cabinet').slice(0, 40) || 'Cabinet',
      u: clamp(parseInt(rr.u, 10) || 42, 4, 60),
      maxW: clamp(num(rr.maxW, DEFAULT_MAX_W), 0, MAX_RACK_W),
      // diagrams saved before free positioning land in a tidy row
      x: clamp(num(rr.x, i * cabStep), 0, 4000),
      y: clamp(num(rr.y, 0), 0, 4000),
      devices: [],
    };
    const taken = [];
    for (const d of (Array.isArray(rr.devices) ? rr.devices : [])) {
      if (!d || typeof d !== 'object') continue;
      const type = TYPES[d.type] ? d.type : 'server';
      const u = clamp(parseInt(d.u, 10) || 1, 1, Math.max(...TYPES[type].heights));
      const pos = clamp(parseInt(d.pos, 10) || 1, 1, rack.u);
      const start = pos - 1;
      if (start + u > rack.u) continue;                                  // hangs off the top
      if (taken.some((t) => start < t.b && t.a < start + u)) continue;    // overlaps
      taken.push({ a: start, b: start + u });
      const def = POWER[type](u);
      const idle = clamp(num(d.idle, def.idle), 0, MAX_DEVICE_W);
      rack.devices.push({
        id: nextId('d'),
        type, u, pos,
        label: String(d.label ?? '').slice(0, 60) || TYPES[type].name,
        sub: String(d.sub ?? '').slice(0, 60),
        color: COLORS.includes(d.color) ? d.color : TYPES[type].color,
        idle,
        peak: clamp(num(d.peak, def.peak), idle, MAX_DEVICE_W),
      });
    }
    s.racks.push(rack);
  }
  if (!s.racks.length) throw new Error('no cabinets');
  s.activeRackId = s.racks[0].id;
  return s;
}

/* ─────────────────────────── palette ─────────────────────────── */

function buildPalette() {
  for (const [containerId, type] of [['paletteServers', 'server'],
                                     ['paletteSwitches', 'switch'],
                                     ['paletteFirewalls', 'firewall']]) {
    const box = $(containerId);
    box.innerHTML = '';
    // a handful of sizes get proportional rows; long lists (servers, 1-20U) get a grid
    const grid = TYPES[type].heights.length > 8;
    box.classList.toggle('grid', grid);
    for (const u of TYPES[type].heights) {
      const item = document.createElement('div');
      item.className = 'p-item' + (grid ? ' compact' : '');
      item.style.borderLeftColor = TYPES[type].color;
      if (!grid) item.style.height = Math.min(26 + u * 5, 52) + 'px';
      item.dataset.type = type;
      item.dataset.u = String(u);
      item.innerHTML = grid
        ? `<span class="p-u">${u}U</span>`
        : `<span class="p-u">${u}U</span><span class="p-name">${TYPES[type].name}</span>`;
      item.title = `${u}U ${TYPES[type].name} — drag into a cabinet`;
      box.appendChild(item);
    }
  }
}

function addDevice(rack, type, u, start) {
  const dev = {
    id: nextId('d'),
    type, u,
    pos: start + 1,
    label: defaultLabel(type),
    sub: '',
    color: TYPES[type].color,
    ...POWER[type](u),
  };
  rack.devices.push(dev);
  state.selectedId = dev.id;
  state.activeRackId = rack.id;
  return dev;
}

/* ─────────────────────────── render ─────────────────────────── */

function render() {
  el.canvas.innerHTML = '';
  for (const rack of state.racks) {
    const node = cabinetNode(rack);
    node.style.left = rack.x * GRID + 'px';
    node.style.top = rack.y * GRID + 'px';
    el.canvas.appendChild(node);
  }
  const tile = addTileNode();
  el.canvas.appendChild(tile);
  sizeCanvas(tile);

  renderCabinetPanel();
  renderInspector();
  renderStats();

  el.numTop.checked = state.numberFromTop;
  el.btnUndo.disabled = !undoStack.length;
  el.btnRedo.disabled = !redoStack.length;
}

/** Park the add-tile beside the last cabinet, then size the canvas to its contents so the
    stage can scroll to every edge. Measured, not computed, so CSS stays the source of
    truth for cabinet width. */
function sizeCanvas(tile) {
  const racks = [...el.canvas.querySelectorAll('.rack')];
  if (racks.length) {
    cabStep = Math.ceil((racks[0].offsetWidth + 18) / GRID);   // width + gap, in grid units
  }

  const last = orderedRacks()[state.racks.length - 1];
  if (last) {
    tile.style.left = (last.x + cabStep) * GRID + 'px';
    tile.style.top = last.y * GRID + 'px';
    const node = el.canvas.querySelector(`.rack[data-rack="${last.id}"]`);
    tile.style.height = node ? node.offsetHeight + 'px' : '260px';
  } else {
    tile.style.left = '0px';
    tile.style.top = '0px';
    tile.style.height = '260px';
  }

  let right = 0, bottom = 0;
  for (const node of el.canvas.children) {
    if (node.classList.contains('add-tile') && preview) continue;   // hidden in preview
    right = Math.max(right, node.offsetLeft + node.offsetWidth);
    bottom = Math.max(bottom, node.offsetTop + node.offsetHeight);
  }
  const width = right + CANVAS_PAD;
  el.canvas.style.width = width + 'px';
  el.canvas.style.height = bottom + CANVAS_PAD + 'px';

  // Centre only the slack. CSS centring (auto margins or justify-content) would push the
  // canvas's left edge out of scroll range as soon as it is wider than the stage.
  const cs = getComputedStyle(el.stage);
  const avail = el.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  el.canvas.style.marginLeft = Math.max(0, Math.round((avail - width) / 2)) + 'px';
}

/** A cabinet's footprint on the grid, measured from its rendered node. */
function rackFootprint(rack) {
  const node = el.canvas.querySelector(`.rack[data-rack="${rack.id}"]`);
  return {
    w: node ? Math.ceil(node.offsetWidth / GRID) : cabStep - 1,
    h: node ? Math.ceil(node.offsetHeight / GRID) : 40,
  };
}

/** true when `rack` can sit at grid (x, y) without covering another cabinet. */
function cabinetFits(rack, x, y) {
  const me = rackFootprint(rack);
  return !state.racks.some((other) => {
    if (other.id === rack.id) return false;
    const o = rackFootprint(other);
    return x < other.x + o.w && other.x < x + me.w &&
           y < other.y + o.h && other.y < y + me.h;
  });
}

function cabinetNode(rack) {
  const used = rack.devices.reduce((n, d) => n + d.u, 0);
  const pw = rackPower(rack);
  const over = isOverBudget(rack);

  const wrap = document.createElement('div');
  wrap.className = 'rack' + (rack.id === state.activeRackId ? ' active' : '');
  wrap.dataset.rack = rack.id;

  const head = document.createElement('div');
  head.className = 'rack-head';
  const name = document.createElement('span');
  name.className = 'rack-head-name';
  name.textContent = rack.name || 'Untitled cabinet';
  name.title = 'Double-click to rename';
  const meta = document.createElement('span');
  meta.className = 'rack-head-meta';
  meta.textContent = rack.maxW ? `${rack.u}U · ${fmtW(rack.maxW)} max` : `${rack.u}U`;
  head.append(name, meta);

  const body = document.createElement('div');
  body.className = 'rack-body';

  const railHtml = Array.from({ length: rack.u }, (_, k) => {
    const i = rack.u - 1 - k;                     // top row first in DOM order
    return `<div class="u-num" style="bottom:${i * UH}px">${uNumberAt(rack, i)}</div>`;
  }).join('');
  const railL = document.createElement('div');
  railL.className = 'rail';
  railL.innerHTML = railHtml;
  const railR = document.createElement('div');
  railR.className = 'rail';
  railR.innerHTML = railHtml;

  const slots = document.createElement('div');
  slots.className = 'slots';
  slots.dataset.rack = rack.id;
  slots.style.height = rack.u * UH + 'px';
  for (const d of [...rack.devices].sort((a, b) => a.pos - b.pos)) {
    slots.appendChild(deviceNode(rack, d));
  }

  body.append(railL, slots, railR);

  const foot = document.createElement('div');
  foot.className = 'rack-foot' + (over ? ' over' : '');
  foot.textContent =
    `${rack.devices.length} device${rack.devices.length === 1 ? '' : 's'} · ` +
    `${used}U used · ${rack.u - used}U free · ` +
    (rack.maxW ? `${fmtRange(pw.idle, pw.peak)} of ${fmtW(rack.maxW)}${over ? ' — over budget' : ''}`
               : `${fmtRange(pw.idle, pw.peak)}`);
  foot.title = `Idle ${fmtW(pw.idle)}, peak ${fmtW(pw.peak)}` +
               (rack.maxW ? ` — budget ${fmtW(rack.maxW)}` : ' — no power limit set');

  wrap.append(head, body, foot);
  return wrap;
}

function addTileNode() {
  const tile = document.createElement('button');
  tile.className = 'add-tile';
  tile.id = 'addTile';
  tile.title = 'Add another cabinet';
  tile.innerHTML = '<span class="add-plus">+</span><span>Add cabinet</span>';
  tile.addEventListener('click', addCabinet);
  return tile;
}

function deviceNode(rack, d) {
  const node = document.createElement('div');
  node.className = `device t-${d.type}` + (d.id === state.selectedId ? ' selected' : '');
  node.dataset.id = d.id;
  node.dataset.u = String(d.u);
  node.style.setProperty('--dev', d.color);
  node.style.bottom = (d.pos - 1) * UH + 'px';
  node.style.height = d.u * UH - 2 + 'px';
  node.title = `${d.label} — ${d.u}U ${TYPES[d.type].name} in ${rack.name} ` +
               `@ U${displayU(rack, d)} · ${fmtRange(d.idle, d.peak)} ` +
               `(double-click to rename)`;

  const face = document.createElement('div');
  face.className = 'dev-face';

  const text = document.createElement('div');
  text.className = 'dev-text';
  const label = document.createElement('div');
  label.className = 'dev-label';
  label.textContent = d.label;
  text.appendChild(label);
  if (d.sub) {
    const sub = document.createElement('div');
    sub.className = 'dev-sub';
    sub.textContent = d.sub;
    text.appendChild(sub);
  }

  const tag = document.createElement('div');
  tag.className = 'dev-tag';
  tag.textContent = `${d.u}U ${TYPES[d.type].tag} · ${fmtW(d.peak)}`;

  const led = document.createElement('div');
  led.className = 'dev-led';

  node.append(face, text, tag, led);
  return node;
}

/** Selection-only repaint. A full render() would replace the device nodes, which breaks
    the browser's dblclick pairing (and so rename-in-place). */
function applySelection() {
  for (const node of el.canvas.querySelectorAll('.device')) {
    node.classList.toggle('selected', node.dataset.id === state.selectedId);
  }
  for (const node of el.canvas.querySelectorAll('.rack')) {
    node.classList.toggle('active', node.dataset.rack === state.activeRackId);
  }
  renderCabinetPanel();
  renderInspector();
  save();            // which cabinet is active survives a reload; it isn't undo history
}

function renderCabinetPanel() {
  const rack = activeRack();
  if (!rack) return;
  if (el.cabName.value !== rack.name) el.cabName.value = rack.name;
  if (el.cabU.value !== String(rack.u)) el.cabU.value = String(rack.u);
  if (el.cabW.value !== String(rack.maxW)) el.cabW.value = String(rack.maxW);
  el.btnDelCab.disabled = state.racks.length < 2;
}

function renderStats() {
  const totalU = state.racks.reduce((n, r) => n + r.u, 0);
  const usedU = allDevices().reduce((n, d) => n + d.u, 0);
  const pct = totalU ? Math.round((usedU / totalU) * 100) : 0;

  const budget = state.racks.reduce((n, r) => n + r.maxW, 0);
  const draw = state.racks.reduce((acc, r) => {
    const p = rackPower(r);
    return { idle: acc.idle + p.idle, peak: acc.peak + p.peak };
  }, { idle: 0, peak: 0 });
  const wPct = budget ? Math.round((draw.peak / budget) * 100) : 0;

  const byType = Object.keys(TYPES).map((t) => {
    const list = allDevices().filter((d) => d.type === t);
    return `${TYPES[t].plural}: <b>${list.length}</b> (${list.reduce((n, d) => n + d.u, 0)}U, ` +
           `${fmtW(list.reduce((n, d) => n + d.peak, 0))} peak)`;
  }).join('<br>');

  const perRack = orderedRacks().map((r) => {
    const u = r.devices.reduce((n, d) => n + d.u, 0);
    const p = r.u ? Math.round((u / r.u) * 100) : 0;
    const pw = rackPower(r);
    const over = isOverBudget(r);
    return `<div class="rack-stat${r.id === state.activeRackId ? ' is-active' : ''}` +
           `${over ? ' over' : ''}" data-rack="${r.id}" title="Select this cabinet">` +
           `<span>${escHtml(r.name)}</span><b>${u}/${r.u}U · ${p}%</b>` +
           `<em>${fmtRange(pw.idle, pw.peak)}${r.maxW ? ` of ${fmtW(r.maxW)}` : ''}</em></div>`;
  }).join('');

  el.stats.innerHTML =
    `<b>${usedU}</b> of <b>${totalU}</b> U used across ` +
    `<b>${state.racks.length}</b> cabinet${state.racks.length === 1 ? '' : 's'} — ${pct}%` +
    `<div class="bar"><i style="width:${pct}%"></i></div>` +
    `<div class="power-line${budget && draw.peak > budget ? ' over' : ''}">` +
    `Power <b>${fmtRange(draw.idle, draw.peak)}</b>` +
    (budget ? ` of <b>${fmtW(budget)}</b> — ${wPct}%` : ' (no limits set)') + `</div>` +
    (budget ? `<div class="bar"><i class="${draw.peak > budget ? 'over' : ''}" ` +
              `style="width:${Math.min(100, wPct)}%"></i></div>` : '') +
    byType +
    `<div class="rack-stats">${perRack}</div>`;
}

function renderInspector() {
  const pair = selectedPair();
  el.inspector.hidden = !pair;
  el.inspectorEmpty.hidden = !!pair;
  if (!pair) return;
  const { rack, dev: d } = pair;

  el.fLabel.value = d.label;
  el.fSub.value = d.sub;
  el.fIdle.value = String(d.idle);
  el.fPeak.value = String(d.peak);
  el.fCab.innerHTML = orderedRacks()
    .map((r) => `<option value="${r.id}">${escHtml(r.name)}</option>`).join('');
  el.fCab.value = rack.id;
  el.fType.value = d.type;

  el.fHeight.innerHTML = TYPES[d.type].heights
    .map((u) => `<option value="${u}">${u}U</option>`).join('');
  el.fHeight.value = String(d.u);

  el.fPos.max = String(rack.u);
  el.fPos.value = String(displayU(rack, d));
  el.fPos.previousElementSibling.textContent =
    state.numberFromTop ? 'Top position (U)' : 'Bottom position (U)';

  el.fSwatches.innerHTML = COLORS
    .map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" ` +
                `aria-pressed="${c === d.color}" title="${c}"></button>`).join('');
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ─────────────────────────── dragging ─────────────────────────── */

let drag = null;

/** The cabinet whose slot column is under (or nearest to) the pointer. */
function slotsUnderPointer(x, y) {
  let best = null, bestDist = Infinity;
  for (const node of el.canvas.querySelectorAll('.slots')) {
    const r = node.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
    const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
    if (dx > 60 || dy > 40) continue;              // tolerance around each cabinet
    const dist = dx * 4 + dy;                      // horizontal proximity decides the cabinet
    if (dist < bestDist) { bestDist = dist; best = { node, rect: r }; }
  }
  return best;
}

function beginDrag(ev, cfg) {
  drag = Object.assign({
    moved: false, startX: ev.clientX, startY: ev.clientY,
    ghost: null, valid: false, target: null,
  }, cfg);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function makeGhost(d, width) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.style.setProperty('--dev', d.color);
  g.style.width = width + 'px';
  g.style.height = d.u * UH - 2 + 'px';
  g.textContent = `${d.label}  ·  ${d.u}U`;
  document.body.appendChild(g);
  return g;
}

function onDragMove(ev) {
  if (!drag) return;
  if (preview) return cancelDrag();                  // e.g. P pressed mid-drag

  if (!drag.moved) {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 4) return;
    drag.moved = true;
    const pair = drag.mode === 'move' ? findDevice(drag.id) : null;
    const shape = pair ? pair.dev
      : { u: drag.u, color: TYPES[drag.type].color, label: TYPES[drag.type].name };
    if (drag.mode === 'move' && !pair) { onDragEnd(); return; }
    const anySlots = el.canvas.querySelector('.slots');
    drag.ghost = makeGhost(shape, anySlots ? anySlots.clientWidth : 240);
    if (pair) {
      const node = el.canvas.querySelector(`.device[data-id="${drag.id}"]`);
      if (node) node.classList.add('dragging');
    }
  }

  drag.ghost.style.left = (ev.clientX - drag.ghostDX) + 'px';
  drag.ghost.style.top = (ev.clientY - drag.ghostDY) + 'px';

  const hit = slotsUnderPointer(ev.clientX, ev.clientY);
  for (const node of el.canvas.querySelectorAll('.slots')) {
    node.classList.toggle('drop-active', !!hit && node === hit.node);
  }

  if (!hit) {
    drag.valid = false;
    drag.target = null;
    placement.hidden = true;
    return;
  }

  const rack = rackById(hit.node.dataset.rack);
  const u = drag.mode === 'move' ? findDevice(drag.id).dev.u : drag.u;
  const raw = Math.round((hit.rect.bottom - ev.clientY) / UH - drag.grabU);
  const start = clamp(raw, 0, rack.u - u);
  const ok = fits(rack, start, u, drag.mode === 'move' ? drag.id : null);

  drag.target = { rackId: rack.id, start };
  drag.valid = ok;

  if (placement.parentNode !== hit.node) hit.node.appendChild(placement);
  placement.hidden = false;
  placement.classList.toggle('invalid', !ok);
  placement.style.bottom = start * UH + 'px';
  placement.style.height = u * UH - 2 + 'px';
}

/** Detach the drag listeners and clear its visuals. Returns the finished drag, if any. */
function teardownDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);

  placement.hidden = true;
  if (placement.parentNode) placement.parentNode.removeChild(placement);
  for (const node of el.canvas.querySelectorAll('.slots')) node.classList.remove('drop-active');
  if (drag && drag.ghost) drag.ghost.remove();

  const d = drag;
  drag = null;
  return d;
}

/** Abandon an in-flight drag without applying it (used when preview mode takes over). */
function cancelDrag() {
  if (!drag) return;
  teardownDrag();
  render();                                          // drops the .dragging class
}

function onDragEnd() {
  const d = teardownDrag();
  if (!d || preview) return;                         // preview mode never applies a drop

  if (!d.moved) {                                     // a click, not a drag
    if (d.mode === 'new') {
      const rack = activeRack();
      if (!rack) return;
      const start = lowestFreeStart(rack, d.u);
      if (start < 0) return toast(`No free ${d.u}U slot in ${rack.name}.`);
      commit(() => addDevice(rack, d.type, d.u, start));
    }
    return;                                            // nothing moved: no repaint needed
  }

  if (!d.valid) {
    if (d.mode === 'move') toast(d.target ? 'That slot is occupied.' : 'Dropped outside a cabinet.');
    render();                                          // clears the .dragging class
    return;
  }

  const rack = rackById(d.target.rackId);
  if (!rack) return render();

  if (d.mode === 'new') {
    commit(() => addDevice(rack, d.type, d.u, d.target.start));
  } else {
    commit(() => {
      const pair = findDevice(d.id);
      if (!pair) return;
      if (pair.rack.id !== rack.id) {                  // moved to another cabinet
        pair.rack.devices = pair.rack.devices.filter((x) => x.id !== d.id);
        rack.devices.push(pair.dev);
      }
      pair.dev.pos = d.target.start + 1;
      state.selectedId = d.id;
      state.activeRackId = rack.id;
    });
  }
}

/* palette → cabinet */
document.querySelectorAll('.palette').forEach((box) => {
  box.addEventListener('pointerdown', (ev) => {
    const item = ev.target.closest('.p-item');
    if (preview || !item || ev.button !== 0) return;
    ev.preventDefault();
    const u = parseInt(item.dataset.u, 10);
    const r = item.getBoundingClientRect();
    beginDrag(ev, {
      mode: 'new',
      type: item.dataset.type,
      u,
      grabU: u / 2,                                  // grab from the middle
      ghostDX: ev.clientX - r.left,
      ghostDY: (u * UH) / 2,
    });
  });
});

/* select / move inside the cabinets */
el.canvas.addEventListener('pointerdown', (ev) => {
  if (preview || ev.button !== 0) return;
  if (ev.target.isContentEditable) return;           // renaming in place
  if (ev.target.closest('.add-tile')) return;

  const rackEl = ev.target.closest('.rack');
  const node = ev.target.closest('.device');
  let changed = false;

  if (rackEl && rackEl.dataset.rack !== state.activeRackId) {
    state.activeRackId = rackEl.dataset.rack;
    changed = true;
  }

  if (!node) {
    if (state.selectedId !== null) { state.selectedId = null; changed = true; }
    if (changed) applySelection();
    return;
  }

  const pair = findDevice(node.dataset.id);
  if (!pair) return;
  if (state.selectedId !== pair.dev.id) { state.selectedId = pair.dev.id; changed = true; }
  if (changed) applySelection();
  // no preventDefault here: it can suppress the dblclick used for renaming

  const r = node.getBoundingClientRect();
  beginDrag(ev, {
    mode: 'move',
    id: pair.dev.id,
    grabU: (r.bottom - ev.clientY) / UH,             // keep the grabbed point under the cursor
    ghostDX: ev.clientX - r.left,
    ghostDY: ev.clientY - r.top,
  });
});

/* ─────────── dragging a cabinet on the grid, and panning the canvas ─────────── */

let cabDrag = null;   // {id, node, grabX, grabY, x0, y0, x, y}
let pan = null;       // {x, y, left, top, moved}

el.stage.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (ev.target.isContentEditable) return;

  const head = ev.target.closest('.rack-head');
  if (head && !preview) {
    const rackEl = head.closest('.rack');
    const rack = rackById(rackEl.dataset.rack);
    if (!rack) return;
    ev.preventDefault();
    if (state.activeRackId !== rack.id) { state.activeRackId = rack.id; applySelection(); }
    cabDrag = {
      id: rack.id, node: rackEl,
      grabX: ev.clientX, grabY: ev.clientY,
      x0: rack.x, y0: rack.y, x: rack.x, y: rack.y, moved: false,
    };
    window.addEventListener('pointermove', onCabDragMove);
    window.addEventListener('pointerup', onCabDragEnd);
    window.addEventListener('pointercancel', onCabDragEnd);
    return;
  }

  // empty canvas (or any non-interactive chrome): pan the view
  if (ev.target.closest('.rack, .add-tile')) return;
  pan = {
    x: ev.clientX, y: ev.clientY,
    left: el.stage.scrollLeft, top: el.stage.scrollTop, moved: false,
  };
  window.addEventListener('pointermove', onPanMove);
  window.addEventListener('pointerup', onPanEnd);
  window.addEventListener('pointercancel', onPanEnd);
});

function onCabDragMove(ev) {
  if (!cabDrag) return;
  if (preview) return onCabDragEnd();
  const dx = ev.clientX - cabDrag.grabX;
  const dy = ev.clientY - cabDrag.grabY;
  if (!cabDrag.moved) {
    if (Math.hypot(dx, dy) < 4) return;
    cabDrag.moved = true;
    cabDrag.node.classList.add('dragging-cab');
  }
  cabDrag.x = Math.max(0, cabDrag.x0 + Math.round(dx / GRID));   // snap to the grid
  cabDrag.y = Math.max(0, cabDrag.y0 + Math.round(dy / GRID));
  cabDrag.node.style.left = cabDrag.x * GRID + 'px';
  cabDrag.node.style.top = cabDrag.y * GRID + 'px';

  const rack = rackById(cabDrag.id);
  cabDrag.valid = !!rack && cabinetFits(rack, cabDrag.x, cabDrag.y);
  cabDrag.node.classList.toggle('invalid-cab', !cabDrag.valid);
}

function onCabDragEnd() {
  window.removeEventListener('pointermove', onCabDragMove);
  window.removeEventListener('pointerup', onCabDragEnd);
  window.removeEventListener('pointercancel', onCabDragEnd);
  const d = cabDrag;
  cabDrag = null;
  if (!d) return;
  d.node.classList.remove('dragging-cab', 'invalid-cab');
  if (!d.moved || preview) return render();
  if (!d.valid) {                                    // would cover another cabinet
    toast('Cabinets cannot overlap.');
    return render();                                 // snaps the node back
  }
  commit(() => {
    const rack = rackById(d.id);
    if (!rack) return;
    rack.x = d.x;
    rack.y = d.y;
  });
}

function onPanMove(ev) {
  if (!pan) return;
  const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y;
  if (!pan.moved) {
    if (Math.hypot(dx, dy) < 3) return;
    pan.moved = true;
    el.stage.classList.add('panning');
  }
  el.stage.scrollLeft = pan.left - dx;
  el.stage.scrollTop = pan.top - dy;
}

function onPanEnd() {
  window.removeEventListener('pointermove', onPanMove);
  window.removeEventListener('pointerup', onPanEnd);
  window.removeEventListener('pointercancel', onPanEnd);
  el.stage.classList.remove('panning');
  pan = null;
}

/** Lay every cabinet out in one row, in its current reading order. */
function arrangeRow() {
  commit(() => {
    orderedRacks().forEach((rack, i) => {
      rack.x = i * cabStep;
      rack.y = 0;
    });
  });
  el.stage.scrollTo({ left: 0, top: 0 });
  toast('Cabinets arranged in a row.');
}

$('btnArrange').addEventListener('click', arrangeRow);

/* ─────────────────────────── inline editing ─────────────────────────── */

/** Make `node` editable; commitFn(text) runs on Enter/blur, Esc restores. */
function inlineEdit(node, original, commitFn) {
  node.contentEditable = 'true';
  node.spellcheck = false;
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    node.contentEditable = 'false';
    node.removeEventListener('keydown', onKey);
    node.removeEventListener('blur', onBlur);
    const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (keep && text && text !== original) commitFn(text);
    else render();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();                             // don't trigger global shortcuts
  };
  const onBlur = () => finish(true);

  node.addEventListener('keydown', onKey);
  node.addEventListener('blur', onBlur);
}

el.canvas.addEventListener('dblclick', (ev) => {
  if (preview) return;
  const deviceEl = ev.target.closest('.device');
  if (deviceEl) {
    const pair = findDevice(deviceEl.dataset.id);
    if (!pair) return;
    inlineEdit(deviceEl.querySelector('.dev-label'), pair.dev.label, (text) => {
      commit(() => {
        const p = findDevice(deviceEl.dataset.id);
        if (p) p.dev.label = text;
      });
    });
    return;
  }
  const nameEl = ev.target.closest('.rack-head-name');
  if (nameEl) {
    const rackEl = nameEl.closest('.rack');
    const rack = rackById(rackEl.dataset.rack);
    if (!rack) return;
    inlineEdit(nameEl, rack.name, (text) => {
      commit(() => {
        const r = rackById(rackEl.dataset.rack);
        if (r) r.name = text.slice(0, 40);
      });
    });
  }
});

/* ─────────────────────────── device inspector ─────────────────────────── */

function editSelected(fn) {
  const pair = selectedPair();
  if (!pair) return;
  commit(() => {
    const p = findDevice(pair.dev.id);
    if (p) fn(p.dev, p.rack);
  });
}

/* live typing shouldn't push a history entry per keystroke: coalesce by pause */
let typingTimer = null;
let typingBefore = null;
function coalesced(apply, repaint) {
  if (typingBefore === null) typingBefore = snapshot();
  apply();
  save();
  if (repaint) repaint();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (typingBefore && typingBefore !== snapshot()) {
      undoStack.push(typingBefore);
      redoStack.length = 0;
      el.btnUndo.disabled = false;
      el.btnRedo.disabled = true;
    }
    typingBefore = null;
  }, 700);
}

function editLive(fn) {
  const pair = selectedPair();
  if (!pair) return;
  coalesced(() => fn(pair.dev), () => {
    // repaint only the affected node so the caret stays put in the text input
    const node = el.canvas.querySelector(`.device[data-id="${pair.dev.id}"]`);
    if (node) node.replaceWith(deviceNode(pair.rack, pair.dev));
    renderStats();
  });
}

el.fLabel.addEventListener('input', () => editLive((d) => { d.label = el.fLabel.value; }));
el.fSub.addEventListener('input', () => editLive((d) => { d.sub = el.fSub.value; }));

/** Re-derive the power range when the device is still carrying its type/size defaults. */
function syncDefaultPower(d, prevType, prevU) {
  const prev = POWER[prevType](prevU);
  if (d.idle === prev.idle && d.peak === prev.peak) Object.assign(d, POWER[d.type](d.u));
}

function applyPower(which) {
  const pair = selectedPair();
  if (!pair) return;
  let idle = clamp(num(el.fIdle.value, pair.dev.idle), 0, MAX_DEVICE_W);
  let peak = clamp(num(el.fPeak.value, pair.dev.peak), 0, MAX_DEVICE_W);
  if (peak < idle) {                                 // respect whichever field was edited
    if (which === 'idle') peak = idle; else idle = peak;
  }
  editSelected((d) => { d.idle = idle; d.peak = peak; });
  renderInspector();                                 // reflect any clamping back into the fields
}

el.fIdle.addEventListener('change', () => applyPower('idle'));
el.fPeak.addEventListener('change', () => applyPower('peak'));

el.fType.addEventListener('change', () => {
  const type = el.fType.value;
  editSelected((d, rack) => {
    const max = Math.max(...TYPES[type].heights);
    const oldColor = d.color, oldDefault = TYPES[d.type].color;
    const prevType = d.type, prevU = d.u;
    d.type = type;
    if (d.u > max) {
      d.u = max;
      if (!fits(rack, d.pos - 1, d.u, d.id)) {
        const s = lowestFreeStart(rack, d.u, d.id);
        if (s >= 0) d.pos = s + 1;
      }
    }
    if (oldColor === oldDefault) d.color = TYPES[type].color;   // keep custom colors
    syncDefaultPower(d, prevType, prevU);                       // and custom power ranges
  });
});

el.fHeight.addEventListener('change', () => {
  const u = parseInt(el.fHeight.value, 10);
  const pair = selectedPair();
  if (!pair) return;
  const { rack, dev } = pair;
  if (fits(rack, dev.pos - 1, u, dev.id)) {
    return editSelected((d) => {
      const prevU = d.u;
      d.u = u;
      syncDefaultPower(d, d.type, prevU);
    });
  }

  const start = lowestFreeStart(rack, u, dev.id);
  if (start < 0) { toast(`No free ${u}U slot in ${rack.name}.`); return render(); }
  editSelected((d) => {
    const prevU = d.u;
    d.u = u;
    d.pos = start + 1;
    syncDefaultPower(d, d.type, prevU);
  });
  const now = selectedPair();
  toast(`Resized and moved to U${displayU(now.rack, now.dev)}.`);
});

el.fPos.addEventListener('change', () => {
  const pair = selectedPair();
  if (!pair) return;
  const { rack, dev } = pair;
  const want = posFromDisplayU(rack, parseInt(el.fPos.value, 10) || 1, dev.u);
  const start = clamp(want - 1, 0, rack.u - dev.u);
  if (!fits(rack, start, dev.u, dev.id)) { toast('That slot is occupied.'); return render(); }
  editSelected((d) => { d.pos = start + 1; });
});

el.fCab.addEventListener('change', () => {
  const target = rackById(el.fCab.value);
  if (!target) return;
  if (!moveSelectedToRack(target)) render();
});

el.fSwatches.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.swatch');
  if (!btn) return;
  editSelected((d) => { d.color = btn.dataset.color; });
});

$('btnDel').addEventListener('click', deleteSelected);
$('btnDup').addEventListener('click', duplicateSelected);

/** Move the selected device into `target`, keeping its U when free. */
function moveSelectedToRack(target) {
  const pair = selectedPair();
  if (!pair || pair.rack.id === target.id) return false;
  const { dev } = pair;
  let start = dev.pos - 1;
  if (!fits(target, start, dev.u)) start = lowestFreeStart(target, dev.u);
  if (start < 0) { toast(`No free ${dev.u}U slot in ${target.name}.`); return false; }

  commit(() => {
    const p = findDevice(dev.id);
    if (!p) return;
    p.rack.devices = p.rack.devices.filter((x) => x.id !== dev.id);
    p.dev.pos = start + 1;
    target.devices.push(p.dev);
    state.activeRackId = target.id;
  });
  toast(`Moved to ${target.name} @ U${displayU(target, findDevice(dev.id).dev)}.`);
  return true;
}

function deleteSelected() {
  const pair = selectedPair();
  if (!pair) return;
  commit(() => {
    const p = findDevice(pair.dev.id);
    if (!p) return;
    p.rack.devices = p.rack.devices.filter((x) => x.id !== p.dev.id);
    state.selectedId = null;
  });
}

function duplicateSelected() {
  const pair = selectedPair();
  if (!pair) return;
  const { rack, dev } = pair;
  const start = lowestFreeStart(rack, dev.u);
  if (start < 0) return toast(`No free ${dev.u}U slot in ${rack.name}.`);
  commit(() => {
    const r = rackById(rack.id);
    const copy = { ...dev, id: nextId('d'), pos: start + 1, label: nextDeviceLabel(dev.label) };
    r.devices.push(copy);
    state.selectedId = copy.id;
  });
}

function nudgeSelected(delta) {
  const pair = selectedPair();
  if (!pair) return;
  const start = pair.dev.pos - 1 + delta;
  if (!fits(pair.rack, start, pair.dev.u, pair.dev.id)) return;
  editSelected((d) => { d.pos = start + 1; });
}

/** Move the selection to the cabinet `dir` steps away (−1 left, +1 right). */
function shiftSelectedCabinet(dir) {
  const pair = selectedPair();
  if (!pair) return;
  const ordered = orderedRacks();
  const i = ordered.findIndex((r) => r.id === pair.rack.id) + dir;
  if (i < 0 || i >= ordered.length) return;
  moveSelectedToRack(ordered[i]);
}

/* ─────────────────────────── cabinet management ─────────────────────────── */

function addCabinet() {
  const from = activeRack();
  const rack = newRack(from ? nextCabinetName(from.name) : 'Cabinet A',
                       from ? from.u : 42, from ? from.maxW : DEFAULT_MAX_W,
                       freeColumn(), from ? from.y : 0);
  commit(() => {
    state.racks.push(rack);
    state.activeRackId = rack.id;
    state.selectedId = null;
  });
  // keep the new cabinet in view when the row overflows
  const node = el.canvas.querySelector(`.rack[data-rack="${rack.id}"]`);
  if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  toast(`Added ${rack.name}.`);
}

function duplicateCabinet() {
  const from = activeRack();
  if (!from) return;
  const copy = {
    id: nextId('r'),
    name: nextCabinetName(from.name),
    u: from.u,
    maxW: from.maxW,
    x: freeColumn(),
    y: from.y,
    devices: from.devices.map((d) => ({ ...d, id: nextId('d') })),
  };
  commit(() => {
    state.racks.splice(rackIndex(from.id) + 1, 0, copy);
    state.activeRackId = copy.id;
    state.selectedId = null;
  });
  toast(`Duplicated as ${copy.name}.`);
}

function deleteCabinet() {
  const rack = activeRack();
  if (!rack) return;
  if (state.racks.length < 2) return toast('At least one cabinet is required.');
  if (rack.devices.length &&
      !confirm(`Delete ${rack.name} and its ${rack.devices.length} device(s)?`)) return;
  commit(() => {
    const i = rackIndex(rack.id);
    state.racks.splice(i, 1);
    state.activeRackId = state.racks[Math.min(i, state.racks.length - 1)].id;
    if (!findDevice(state.selectedId)) state.selectedId = null;
  });
}

$('btnAddCab').addEventListener('click', addCabinet);
$('btnDupCab').addEventListener('click', duplicateCabinet);
el.btnDelCab.addEventListener('click', deleteCabinet);

el.cabName.addEventListener('input', () => {
  const rack = activeRack();
  if (!rack) return;
  coalesced(() => { rack.name = el.cabName.value; }, () => {
    const nameEl = el.canvas.querySelector(`.rack[data-rack="${rack.id}"] .rack-head-name`);
    if (nameEl) nameEl.textContent = rack.name || 'Untitled cabinet';
    renderStats();
  });
});

el.cabU.addEventListener('change', () => {
  const rack = activeRack();
  if (!rack) return;
  const u = clamp(parseInt(el.cabU.value, 10) || 42, 4, 60);
  const overflow = rack.devices.filter((d) => d.pos - 1 + d.u > u);
  if (overflow.length &&
      !confirm(`${overflow.length} device(s) sit above U${u} in ${rack.name} and will be removed. Continue?`)) {
    return render();
  }
  commit(() => {
    const r = rackById(rack.id);
    r.u = u;
    r.devices = r.devices.filter((d) => d.pos - 1 + d.u <= u);
    if (!findDevice(state.selectedId)) state.selectedId = null;
  });
  if (el.zoom.value === 'fit') applyZoom('fit');       // a taller cabinet needs shorter units
});

el.cabW.addEventListener('change', () => {
  const rack = activeRack();
  if (!rack) return;
  const w = clamp(num(el.cabW.value, DEFAULT_MAX_W), 0, MAX_RACK_W);
  commit(() => { rackById(rack.id).maxW = w; });
});

el.numTop.addEventListener('change', () => {
  commit(() => { state.numberFromTop = el.numTop.checked; });
});

/* clicking a cabinet in the occupancy list selects it */
el.stats.addEventListener('click', (ev) => {
  const row = ev.target.closest('.rack-stat');
  if (!row) return;
  state.activeRackId = row.dataset.rack;
  state.selectedId = null;
  applySelection();
  renderStats();
});

/* ─────────────────────────── preview mode ─────────────────────────── */

function setPreview(on) {
  if (preview === on) return;
  preview = on;
  document.body.classList.toggle('preview', on);
  $('btnExitPreview').hidden = !on;
  $('btnPreview').textContent = on ? 'Editing' : 'Preview';
  if (on) {
    cancelDrag();                                    // a drag must not survive the switch
    state.selectedId = null;                         // nothing is selectable in preview
    save();
  }
  // the panels have just appeared/vanished, so the stage changed size
  applyZoom(el.zoom.value);                          // calls render()
}

$('btnPreview').addEventListener('click', () => setPreview(!preview));
$('btnExitPreview').addEventListener('click', () => setPreview(false));

/* ─────────────────────────── zoom ─────────────────────────── */

/** Resolve the zoom setting to a pixel unit height. 'fit' sizes the tallest cabinet. */
function unitHeightFor(setting) {
  if (setting !== 'fit') return clamp(parseInt(setting, 10) || 26, 12, 40);
  const chrome = 160;                                  // stage padding + head/foot/borders
  const tallest = Math.max(4, ...state.racks.map((r) => r.u));
  return clamp(Math.floor((el.stage.clientHeight - chrome) / tallest), 12, 34);
}

function applyZoom(setting) {
  UH = unitHeightFor(setting);
  document.documentElement.style.setProperty('--uh', UH + 'px');
  render();
}

el.zoom.addEventListener('change', () => {
  try { localStorage.setItem(ZOOM_KEY, el.zoom.value); } catch (_) { /* private mode */ }
  applyZoom(el.zoom.value);
});

window.addEventListener('resize', () => {
  if (el.zoom.value === 'fit') applyZoom('fit');
});

/* ─────────────────────────── keyboard ─────────────────────────── */

document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const mod = ev.metaKey || ev.ctrlKey;

  /* preview mode swallows every edit, undo included; only leaving it stays live */
  if (preview) {
    if (!typing && (ev.key === 'Escape' || ev.key.toLowerCase() === 'p')) {
      ev.preventDefault();
      setPreview(false);
    }
    return;
  }

  if (mod && ev.key.toLowerCase() === 'z') {         // works while typing, by design
    ev.preventDefault();
    ev.shiftKey ? redo() : undo();
    return;
  }
  if (typing) return;
  if (!mod && ev.key.toLowerCase() === 'p') { ev.preventDefault(); return setPreview(true); }
  if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); return duplicateSelected(); }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); return deleteSelected(); }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); return nudgeSelected(1); }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); return nudgeSelected(-1); }
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); return shiftSelectedCabinet(-1); }
  if (ev.key === 'ArrowRight') { ev.preventDefault(); return shiftSelectedCabinet(1); }
  if (ev.key === 'Escape') { state.selectedId = null; return applySelection(); }
  if (ev.key === 'Enter') {
    const pair = selectedPair();
    if (!pair) return;
    ev.preventDefault();
    const node = el.canvas.querySelector(`.device[data-id="${pair.dev.id}"]`);
    if (node) {
      inlineEdit(node.querySelector('.dev-label'), pair.dev.label, (text) => {
        commit(() => {
          const p = findDevice(pair.dev.id);
          if (p) p.dev.label = text;
        });
      });
    }
    return;
  }
  if (ev.key === 'Tab') {                             // cycle bottom → top, cabinet by cabinet
    const ordered = orderedRacks().flatMap((r) =>
      [...r.devices].sort((a, b) => a.pos - b.pos).map((d) => ({ rack: r, dev: d })));
    if (!ordered.length) return;
    ev.preventDefault();
    const i = ordered.findIndex((o) => o.dev.id === state.selectedId);
    const step = ev.shiftKey ? -1 : 1;
    const pick = ordered[(i + step + ordered.length) % ordered.length];
    state.selectedId = pick.dev.id;
    state.activeRackId = pick.rack.id;
    applySelection();
  }
});

/* ─────────────────────────── export / import ─────────────────────────── */

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function slug() {
  if (state.racks.length !== 1) return 'cabinets';
  return (state.racks[0].name || 'cabinet').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cabinet';
}

$('btnSaveJson').addEventListener('click', () => {
  const data = { format: 'diacab/3', numberFromTop: state.numberFromTop, racks: state.racks };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${slug()}.json`);
});

$('btnLoadJson').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const next = normalize(parsed);                    // throws before we touch state
    commit(() => { state = next; });
    if (el.zoom.value === 'fit') applyZoom('fit');
    toast(`Loaded ${state.racks.length} cabinet(s), ${allDevices().length} device(s).`);
  } catch (_) {
    toast('That file is not a DiaCab diagram.');
  }
});

$('btnClear').addEventListener('click', () => {
  if (!allDevices().length) return;
  if (!confirm(`Remove every device from all ${state.racks.length} cabinet(s)?`)) return;
  commit(() => {
    for (const r of state.racks) r.devices = [];
    state.selectedId = null;
  });
});

/* ── SVG rendering, used for both SVG and PNG export ── */

function buildSvg() {
  const U = 26, railW = 30, slotW = 360, gap = 4, pad = 16;
  const headH = 42, footH = 26, inner = 6;
  const cabW = railW * 2 + slotW + gap * 2 + inner * 2;
  const font = 'ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  const p = [];

  // mirror the canvas layout: grid coordinates, normalised so the top-left cabinet sits
  // at the padding origin
  const minX = Math.min(...state.racks.map((r) => r.x));
  const minY = Math.min(...state.racks.map((r) => r.y));
  const layout = state.racks.map((rack) => {
    const bodyH = rack.u * U + inner * 2;
    return {
      rack,
      x0: pad + (rack.x - minX) * GRID,
      y0: pad + (rack.y - minY) * GRID,
      bodyH,
      panelH: headH + bodyH + footH,
    };
  });
  const w = pad + Math.max(...layout.map((l) => l.x0 + cabW));
  const h = pad + Math.max(...layout.map((l) => l.y0 + l.panelH));

  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
         `viewBox="0 0 ${w} ${h}" font-family="${escHtml(font)}">`);
  p.push(`<rect width="${w}" height="${h}" fill="#0e1116"/>`);

  for (const { rack, x0, y0, bodyH, panelH } of layout) {
    const bodyY = y0 + headH;
    const slotX = x0 + inner + railW + gap;
    const slotY = bodyY + inner;
    const used = rack.devices.reduce((n, d) => n + d.u, 0);

    p.push(`<g>`);
    p.push(`<rect x="${x0}" y="${y0}" width="${cabW}" height="${panelH}" rx="10" fill="#1c222b" stroke="#313a47"/>`);
    p.push(`<text x="${x0 + inner + 4}" y="${y0 + 24}" fill="#e6edf3" font-size="14" font-weight="650">${escHtml(rack.name || 'Untitled cabinet')}</text>`);
    p.push(`<text x="${x0 + cabW - inner - 4}" y="${y0 + 24}" fill="#8b98a8" font-size="11" text-anchor="end">` +
           `${rack.u}U${rack.maxW ? ` · ${fmtW(rack.maxW)} max` : ''}</text>`);
    p.push(`<rect x="${x0 + 2}" y="${bodyY}" width="${cabW - 4}" height="${bodyH}" rx="6" fill="#0b0e13" stroke="#313a47"/>`);

    for (const rx of [x0 + inner, slotX + slotW + gap]) {
      p.push(`<rect x="${rx}" y="${slotY}" width="${railW}" height="${rack.u * U}" rx="4" fill="#171d25" stroke="#2b333f"/>`);
    }
    p.push(`<rect x="${slotX}" y="${slotY}" width="${slotW}" height="${rack.u * U}" rx="4" fill="#0f141a" stroke="#2b333f"/>`);

    for (let i = 0; i < rack.u; i++) {
      const y = slotY + (rack.u - 1 - i) * U;          // top edge of slot i
      if (i < rack.u - 1) {
        p.push(`<line x1="${slotX}" y1="${y}" x2="${slotX + slotW}" y2="${y}" stroke="#1a212a"/>`);
      }
      const label = uNumberAt(rack, i);
      for (const cx of [x0 + inner + railW / 2, slotX + slotW + gap + railW / 2]) {
        p.push(`<text x="${cx}" y="${y + U / 2 + 3}" fill="#5d6b7c" font-size="9" text-anchor="middle">${label}</text>`);
      }
    }

    for (const d of [...rack.devices].sort((a, b) => a.pos - b.pos)) {
      const dh = d.u * U - 2;
      const y = slotY + (rack.u - (d.pos - 1) - d.u) * U + 1;
      const x = slotX + 2, dw = slotW - 4;
      p.push(`<g>`);
      p.push(`<rect x="${x}" y="${y}" width="${dw}" height="${dh}" rx="4" fill="#202832" stroke="rgba(255,255,255,.14)"/>`);
      // 4px accent bar with a rounded left edge (round rect + square patch on its right)
      p.push(`<rect x="${x}" y="${y}" width="8" height="${dh}" rx="4" fill="${d.color}"/>`);
      p.push(`<rect x="${x + 4}" y="${y}" width="4" height="${dh}" fill="#202832"/>`);
      const fx = x + 9, fy = y + 4, fw = 58, fh = dh - 8;
      p.push(`<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="3" fill="#12171e" stroke="rgba(255,255,255,.08)"/>`);
      // chassis face: drive-bay rows on servers, port rows on switches/firewalls
      if (d.type === 'server') {
        for (let ly = fy + 3; ly < fy + fh - 2; ly += 4) {
          p.push(`<line x1="${fx + 3}" y1="${ly}" x2="${fx + fw - 3}" y2="${ly}" stroke="rgba(255,255,255,.10)" stroke-width="2"/>`);
        }
      } else {
        for (let lx = fx + 4; lx < fx + fw - 2; lx += 7) {
          p.push(`<line x1="${lx}" y1="${fy + 3}" x2="${lx}" y2="${fy + fh - 3}" stroke="rgba(255,255,255,.13)" stroke-width="3"/>`);
        }
      }
      const tx = x + 75;
      if (d.sub && d.u > 1) {
        p.push(`<text x="${tx}" y="${y + dh / 2 - 1}" fill="#e6edf3" font-size="12" font-weight="600">${escHtml(d.label)}</text>`);
        p.push(`<text x="${tx}" y="${y + dh / 2 + 11}" fill="#8b98a8" font-size="10">${escHtml(d.sub)}</text>`);
      } else {
        p.push(`<text x="${tx}" y="${y + dh / 2 + 4}" fill="#e6edf3" font-size="12" font-weight="600">${escHtml(d.label)}</text>`);
      }
      if (d.u > 1) {
        p.push(`<text x="${x + dw - 24}" y="${y + dh / 2 + 4}" fill="#8b98a8" font-size="9" text-anchor="end">` +
               `${d.u}U ${TYPES[d.type].tag.toUpperCase()} · ${fmtW(d.peak)}</text>`);
      }
      p.push(`<circle cx="${x + dw - 10}" cy="${y + dh / 2}" r="3" fill="${d.color}"/>`);
      p.push(`</g>`);
    }

    const pw = rackPower(rack);
    const over = isOverBudget(rack);
    p.push(`<text x="${x0 + cabW - inner - 4}" y="${bodyY + bodyH + 18}" fill="${over ? '#ff9d96' : '#8b98a8'}" font-size="10" text-anchor="end">` +
           `${rack.devices.length} device${rack.devices.length === 1 ? '' : 's'} · ${used}U used · ` +
           `${fmtRange(pw.idle, pw.peak)}${rack.maxW ? ` of ${fmtW(rack.maxW)}` : ''}` +
           `${over ? ' — over budget' : ''}</text>`);
    p.push(`</g>`);
  }

  p.push(`</svg>`);
  return p.join('');
}

$('btnExportSvg').addEventListener('click', () => {
  download(new Blob([buildSvg()], { type: 'image/svg+xml' }), `${slug()}.svg`);
  toast('SVG exported.');
});

$('btnExportPng').addEventListener('click', () => {
  const svg = buildSvg();
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  const w = +m[1], h = +m[2], scale = 2;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    c.toBlob((blob) => {
      download(blob, `${slug()}.png`);
      toast('PNG exported.');
    }, 'image/png');
  };
  img.onerror = () => toast('PNG export failed — try SVG.');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
});

el.btnUndo.addEventListener('click', undo);
el.btnRedo.addEventListener('click', redo);

/* ─────────────────────────── boot ─────────────────────────── */

function seed() {
  state = blankState();
  const rackA = state.racks[0];
  rackA.maxW = 6000;
  const rackB = newRack('Cabinet B', 42, 6000, cabStep, 0);
  state.racks.push(rackB);

  const fill = (rack, plan) => {
    let at = rack.u - 1;                              // start at the top
    for (const [type, u, label, sub] of plan) {
      at -= u - 1;
      if (at < 0) break;
      rack.devices.push({ id: nextId('d'), type, u, pos: at + 1, label, sub,
                          color: TYPES[type].color, ...POWER[type](u) });
      at -= 1;
    }
  };

  fill(rackA, [
    ['firewall', 1, 'fw-edge-01', 'Palo Alto PA-460'],
    ['switch', 1, 'sw-tor-01', 'Arista 7050 · 48x10G'],
    ['server', 1, 'web-01', 'Dell R660'],
    ['server', 1, 'web-02', 'Dell R660'],
    ['server', 2, 'db-01', 'Dell R760 · 1TB RAM'],
    ['server', 4, 'stor-01', 'Ceph OSD · 24 bay'],
  ]);
  fill(rackB, [
    ['firewall', 1, 'fw-edge-02', 'Palo Alto PA-460'],
    ['switch', 1, 'sw-tor-02', 'Arista 7050 · 48x10G'],
    ['server', 1, 'web-03', 'Dell R660'],
    ['server', 2, 'db-02', 'Dell R760 · 1TB RAM'],
    ['server', 4, 'stor-02', 'Ceph OSD · 24 bay'],
  ]);
}

buildPalette();
if (!load()) { seed(); save(); }

let zoomPref = 'fit';
try { zoomPref = localStorage.getItem(ZOOM_KEY) || 'fit'; } catch (_) { /* private mode */ }
el.zoom.value = [...el.zoom.options].some((o) => o.value === zoomPref) ? zoomPref : 'fit';
applyZoom(el.zoom.value);

/* undo/redo starts empty, so the initial history buttons are disabled */
undoStack.length = 0;
redoStack.length = 0;
el.btnUndo.disabled = true;
el.btnRedo.disabled = true;
