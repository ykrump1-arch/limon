// Хранилище на JSON-файле. Для 25-30 резидентов этого достаточно.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// На Railway volume монтируется в /data.
// ВАЖНО: не монтировать в /app/data — там лежит tasks.json со справочником.
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (fs.existsSync('/data')) return '/data/db.json';
  return path.join(__dirname, '..', 'data', 'db.json');
}

const FILE = resolveDbPath();
console.log('База данных:', FILE);

const EMPTY = { residents: [], log: [], tech: [], seq: 0 };

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

let timer = null;
export function save() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 300);
}

export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function residents({ all = false } = {}) {
  return load().residents.filter((r) => all || r.active !== false);
}

export function resident(id) {
  return load().residents.find((r) => r.id === id) || null;
}

export function addResident({ name, startedAt, dischargeAt }) {
  const db = load();
  db.seq += 1;
  const r = {
    id: `r${db.seq}`,
    name,
    startedAt,
    dischargeAt,
    active: true,
    tasks: {},   // taskCode -> { issuedAt, closedAt, progress: { groupIdx: [bool] } }
  };
  db.residents.push(r);
  save();
  return r;
}

// ---------- техническая информация ----------

export function addTech({ text, by, byName }) {
  const db = load();
  db.seq += 1;
  const item = {
    id: `t${db.seq}`, text,
    by, byName,
    createdAt: new Date().toISOString(),
    doneAt: null, doneBy: null,
  };
  db.tech.push(item);
  save();
  return item;
}

export function techOpen() {
  return load().tech.filter((t) => !t.doneAt);
}

export function techDone(limit = 15) {
  return load().tech.filter((t) => t.doneAt)
    .sort((a, b) => b.doneAt.localeCompare(a.doneAt)).slice(0, limit);
}

export function techItem(id) {
  return load().tech.find((t) => t.id === id) || null;
}

export function logEntry(e) {
  load().log.push({ ts: new Date().toISOString(), ...e });
  save();
}

export function logAll() { return load().log; }
