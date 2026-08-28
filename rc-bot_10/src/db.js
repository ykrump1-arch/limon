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

const EMPTY = {
  residents: [], log: [], tech: [], seq: 0,
  staff: [],          // { id, name, tgId }
  shift: null,        // { date, members: [staffId], lead: staffId }
};

// Персонал центра. Каждый один раз выбирает себя, дальше подписывается сам.
const STAFF_NAMES = ['Юра', 'Лена', 'Александр', 'Шохрух', 'Максим', 'Азиз', 'Ержан'];

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

// ---------- персонал и смена ----------

// Уникальный id — иначе новый человек может получить id уже существующего
function newStaffId() {
  const db = load();
  let id;
  do { db.seq += 1; id = `s${db.seq}`; } while (db.staff.some((x) => x.id === id));
  return id;
}

export function seedStaff() {
  const db = load();
  if (db.staff.length) return;
  db.staff = STAFF_NAMES.map((name) => ({ id: newStaffId(), name, tgId: null }));
  save();
}

// Персонал из переменной STAFF: «Юра:6996710979, Лена:123456789»
// Имя без ID тоже можно — человек тогда выбирает себя вручную.
export function syncStaffFromEnv(raw) {
  if (!raw) return [];
  const db = load();
  const out = [];

  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [nameRaw, idRaw] = part.split(':').map((x) => (x || '').trim());
    if (!nameRaw) continue;
    const tgId = idRaw && /^\d+$/.test(idRaw) ? idRaw : null;

    let st = db.staff.find((x) => x.name.toLowerCase() === nameRaw.toLowerCase());
    if (!st) {
      st = { id: newStaffId(), name: nameRaw, tgId: null };
      db.staff.push(st);
    }
    if (tgId) {
      // один Telegram — один человек
      for (const x of db.staff) if (x !== st && String(x.tgId) === tgId) x.tgId = null;
      st.tgId = tgId;
    }
    out.push(st);
  }
  save();
  return out;
}

export function addStaff(name, tgId = null) {
  const db = load();
  const exists = db.staff.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    if (tgId) exists.tgId = String(tgId);
    save();
    return { staff: exists, created: false };
  }
  const st = { id: newStaffId(), name, tgId: tgId ? String(tgId) : null };
  db.staff.push(st);
  save();
  return { staff: st, created: true };
}

export function removeStaff(id) {
  const db = load();
  const i = db.staff.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [gone] = db.staff.splice(i, 1);
  const sh = shift();
  sh.members = sh.members.filter((x) => x !== id);
  if (sh.lead === id) sh.lead = sh.members[0] || null;
  save();
  return gone;
}

export function staffTgIds() {
  return load().staff.map((s) => s.tgId).filter(Boolean).map(String);
}

// Разовая починка баз, где у людей могли совпасть id
export function fixStaffIds() {
  const db = load();
  const seen = new Set();
  let fixed = 0;
  for (const st of db.staff) {
    if (!st.id || seen.has(st.id)) { st.id = newStaffId(); fixed++; }
    seen.add(st.id);
  }
  if (fixed) save();
  return fixed;
}

export function staff() { return load().staff; }

export function staffById(id) { return load().staff.find((s) => s.id === id) || null; }

export function staffByTg(tgId) {
  return load().staff.find((s) => String(s.tgId) === String(tgId)) || null;
}

export function linkStaff(staffId, tgId) {
  const db = load();
  for (const s of db.staff) if (String(s.tgId) === String(tgId)) s.tgId = null;
  const s = db.staff.find((x) => x.id === staffId);
  if (s) s.tgId = String(tgId);
  save();
  return s;
}

export function shift() {
  const db = load();
  if (!db.shift) db.shift = { date: null, members: [], lead: null };
  return db.shift;
}

export function setShift(patch) {
  const db = load();
  db.shift = { ...shift(), ...patch };
  save();
  return db.shift;
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

export function dumpPath() { return FILE; }

export function rawJson() {
  return JSON.stringify(load(), null, 2);
}

// Восстановление из копии. Проверяем, что это похоже на нашу базу.
export function restore(json) {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed.residents)) throw new Error('нет списка резидентов');
  data = { ...structuredClone(EMPTY), ...parsed };
  flush();
  return data.residents.length;
}
