// Простое файловое хранилище. Для 25-30 резидентов этого более чем достаточно.
// При переходе на несколько центров заменяется на SQLite или Postgres
// без изменения остального кода — наружу торчат только функции ниже.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Путь к базе.
// На Railway volume монтируется в /data — если папка есть, пишем туда.
// Локально — в ./data рядом с проектом.
// ВАЖНО: volume нельзя монтировать в /app/data — там лежит tasks.json
// со справочником заданий, и пустой volume его перекроет.
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (fs.existsSync('/data')) return '/data/db.json';
  return path.join(__dirname, '..', 'data', 'db.json');
}

const FILE = resolveDbPath();
console.log('База данных:', FILE);

const EMPTY = {
  residents: [],   // { id, name, startedAt, dischargeAt, track, active, tasks: {}, activeTask }
  log: [],         // { ts, residentId, taskCode, groupIdx, unitIdx, by, context }
  events: [],      // { date, type: 'mg', status: 'held'|'cancelled'|'short', by }
  staff: {},       // telegramId -> { name, role }
  seq: 0,
};

let data = null;

export function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const k of Object.keys(EMPTY)) if (data[k] === undefined) data[k] = EMPTY[k];
  } catch {
    data = structuredClone(EMPTY);
  }
  return data;
}

let saveTimer = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  }, 300);
}

export function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function nextId(prefix) {
  const db = load();
  db.seq += 1;
  save();
  return `${prefix}${db.seq}`;
}

export function residents({ activeOnly = true } = {}) {
  const db = load();
  return db.residents.filter((r) => (activeOnly ? r.active !== false : true));
}

export function resident(id) {
  return load().residents.find((r) => r.id === id) || null;
}

export function addResident({ name, startedAt, months = 6, track = 'основная' }) {
  const db = load();
  const start = startedAt ? new Date(startedAt) : new Date();
  const discharge = new Date(start);
  discharge.setMonth(discharge.getMonth() + months);
  const r = {
    id: nextId('r'),
    name,
    startedAt: start.toISOString().slice(0, 10),
    dischargeAt: discharge.toISOString().slice(0, 10),
    track,
    active: true,
    tasks: {},        // taskCode -> { issuedAt, closedAt, progress: { groupIdx: [bool...] } }
    activeTask: null,
  };
  db.residents.push(r);
  save();
  return r;
}

export function logEntry(entry) {
  const db = load();
  db.log.push({ ts: new Date().toISOString(), ...entry });
  save();
}

export function markMg({ date, status, by }) {
  const db = load();
  const d = date || new Date().toISOString().slice(0, 10);
  const existing = db.events.find((e) => e.date === d && e.type === 'mg');
  if (existing) { existing.status = status; existing.by = by; }
  else db.events.push({ date: d, type: 'mg', status, by });
  save();
}

export function events() { return load().events; }
export function logAll() { return load().log; }
export function staff() { return load().staff; }
