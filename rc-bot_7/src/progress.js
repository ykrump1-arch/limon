// Арифметика: прогресс, ожидаемый темп, отставание и опережение.
//
// Принцип простой. Программа = 224 единицы на срок пребывания.
// Прошло 40% срока — ожидаем 40% программы.
// Сравниваем факт с ожиданием, получаем «отстаёт» или «спешит».

import { byCode, tasksFor, unitsFor } from './catalog.js';

export const DAY = 86400000;

export function today() { return new Date().toISOString().slice(0, 10); }

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY);
}

// Разбор даты: 27.04.2026, 27.04.26, 2026-04-27
export function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(+y, +mo - 1, +d);
    if (isNaN(dt)) return null;
    return dt.toISOString().slice(0, 10);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return null;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function addMonths(iso, n) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- прогресс ----------

export function taskProgress(resident, code) {
  const task = byCode[code];
  const rec = resident.tasks[code];
  let done = 0;
  if (rec?.progress) {
    for (const arr of Object.values(rec.progress)) done += arr.filter(Boolean).length;
  }
  return {
    task, rec: rec || null, done,
    total: task.units,
    percent: Math.round((done / task.units) * 100),
    complete: done >= task.units,
    started: !!rec,
  };
}

export function groupProgress(resident, code, gi) {
  const task = byCode[code];
  const group = task.groups[gi];
  const arr = resident.tasks[code]?.progress?.[gi] || [];
  return { group, arr, done: arr.filter(Boolean).length, total: group.count };
}

export function toggleUnit(resident, code, gi, ui) {
  const task = byCode[code];
  const rec = (resident.tasks[code] ||= { issuedAt: today(), closedAt: null, progress: {} });
  const arr = (rec.progress[gi] ||= new Array(task.groups[gi].count).fill(false));
  arr[ui] = !arr[ui];

  // задание закрывается и открывается само, вручную отмечать не нужно
  const tp = taskProgress(resident, code);
  rec.closedAt = tp.complete ? today() : null;
  return arr[ui];
}

export function overall(resident) {
  let done = 0;
  for (const t of tasksFor(resident)) done += taskProgress(resident, t.code).done;
  const total = unitsFor(resident);
  return { done, total, percent: Math.round((done / total) * 100) };
}

// ---------- сроки ----------

export function dayOfProgram(r) { return Math.max(0, daysBetween(r.startedAt, today())); }
export function daysLeft(r) { return daysBetween(today(), r.dischargeAt); }
export function totalDays(r) { return Math.max(1, daysBetween(r.startedAt, r.dischargeAt)); }

// Главная функция сводки: нормально / отстаёт / сильно отстаёт
export function status(r) {
  const o = overall(r);
  const elapsed = Math.min(1, dayOfProgram(r) / totalDays(r));
  const expectedUnits = Math.round(elapsed * o.total);
  const diff = o.done - expectedUnits;                 // − значит отставание
  const diffPct = Math.round((diff / o.total) * 100);

  // 🟢 идёт нормально (по графику или впереди)
  // 🟡 отстаёт
  // 🔴 сильно отстаёт
  let state = 'ok';
  if (diffPct <= -20) state = 'bad';
  else if (diffPct <= -7) state = 'late';

  const left = daysLeft(r);
  const needPerDay = left > 0 ? (o.total - o.done) / left : Infinity;

  return {
    ...o, elapsed, expectedUnits, diff, diffPct, state,
    daysLeft: left, needPerDay,
    icon: state === 'bad' ? '🔴' : state === 'late' ? '🟡' : '🟢',
  };
}

// Текущее задание — первое незакрытое по порядку
export function currentTask(r) {
  for (const t of tasksFor(r)) {
    const tp = taskProgress(r, t.code);
    if (tp.started && !tp.complete) return t;
  }
  return null;
}

export function nextTask(r) {
  return tasksFor(r).find((t) => !r.tasks[t.code]) || null;
}
