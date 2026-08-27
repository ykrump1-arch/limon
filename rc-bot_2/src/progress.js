// Вся арифметика бота: прогресс, остаток, темп, прогноз.
// Принцип: НЕ сравниваем с планом, а измеряем факт и от него считаем прогноз.
// Расписание МГ плавает, поэтому план врёт, а факт — нет.

import { byCode, ORDERED, TOTAL_UNITS } from './catalog.js';
import { logAll } from './db.js';

export const DAY = 86400000;

export function today() { return new Date().toISOString().slice(0, 10); }

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY);
}

// ---------- прогресс по одному заданию ----------

export function taskProgress(resident, taskCode) {
  const task = byCode[taskCode];
  const rec = resident.tasks[taskCode];
  if (!task) return null;
  let done = 0;
  if (rec?.progress) {
    for (const arr of Object.values(rec.progress)) done += arr.filter(Boolean).length;
  }
  return {
    task,
    rec: rec || null,
    done,
    total: task.units,
    percent: Math.round((done / task.units) * 100),
    complete: done >= task.units,
  };
}

export function groupProgress(resident, taskCode, groupIdx) {
  const task = byCode[taskCode];
  const group = task.groups[groupIdx];
  const arr = resident.tasks[taskCode]?.progress?.[groupIdx] || [];
  const done = arr.filter(Boolean).length;
  return { group, arr, done, total: group.count };
}

export function toggleUnit(resident, taskCode, groupIdx, unitIdx) {
  const task = byCode[taskCode];
  const rec = (resident.tasks[taskCode] ||= {
    issuedAt: today(),
    closedAt: null,
    progress: {},
  });
  const arr = (rec.progress[groupIdx] ||= new Array(task.groups[groupIdx].count).fill(false));
  arr[unitIdx] = !arr[unitIdx];
  return arr[unitIdx];
}

// ---------- прогресс по резиденту ----------

export function overall(resident) {
  let done = 0;
  for (const code of Object.keys(resident.tasks)) {
    done += taskProgress(resident, code)?.done || 0;
  }
  return { done, total: TOTAL_UNITS, percent: Math.round((done / TOTAL_UNITS) * 100) };
}

export function daysLeft(resident) {
  return daysBetween(today(), resident.dischargeAt);
}

export function dayOfProgram(resident) {
  return daysBetween(resident.startedAt, today());
}

// Темп: сколько единиц закрыто за последние N дней (по факту, из журнала)
export function pace(residentId, windowDays = 30) {
  const since = new Date(Date.now() - windowDays * DAY).toISOString();
  const entries = logAll().filter(
    (e) => e.residentId === residentId && e.ts >= since && e.action === 'accept'
  );
  const perDay = entries.length / windowDays;
  return { units: entries.length, windowDays, perDay };
}

// Прогноз: успеет ли добить программу к выписке при текущем темпе
export function forecast(resident) {
  const o = overall(resident);
  const left = daysLeft(resident);
  const p = pace(resident.id);
  const remaining = o.total - o.done;

  if (left <= 0) return { status: 'discharged', remaining, left };
  if (p.perDay <= 0) {
    return { status: 'no_data', remaining, left, needPerDay: remaining / left };
  }
  const projected = Math.round(p.perDay * left);
  const gap = remaining - projected;
  return {
    status: gap <= 0 ? 'ok' : 'behind',
    remaining,
    left,
    projected,
    gap,                                  // сколько единиц не успеет
    perDay: p.perDay,
    needPerDay: remaining / left,
  };
}

// Следующее задание по порядку, которое ещё не выдано
export function nextTask(resident) {
  return ORDERED.find((t) => !resident.tasks[t.code]) || null;
}

export function hasActive(resident) {
  if (!resident.activeTask) return false;
  const tp = taskProgress(resident, resident.activeTask);
  return tp && !tp.complete;
}

// ---------- статистика по дому ----------

export function houseStats(windowDays = 30) {
  const since = new Date(Date.now() - windowDays * DAY).toISOString();
  const entries = logAll().filter((e) => e.ts >= since && e.action === 'accept');

  const byContext = {};
  const razbory = new Set();     // уникальные «резидент + день + контекст»
  for (const e of entries) {
    byContext[e.context] = (byContext[e.context] || 0) + 1;
    razbory.add(`${e.residentId}|${e.ts.slice(0, 10)}|${e.context}`);
  }

  return {
    windowDays,
    units: entries.length,
    razbory: razbory.size,
    unitsPerRazbor: razbory.size ? +(entries.length / razbory.size).toFixed(1) : 0,
    byContext,
  };
}

export function mgStats(events, windowDays = 30) {
  const since = new Date(Date.now() - windowDays * DAY).toISOString().slice(0, 10);
  const rows = events.filter((e) => e.type === 'mg' && e.date >= since);
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    windowDays,
    held: count('held'),
    short: count('short'),
    cancelled: count('cancelled'),
    marked: rows.length,
    perWeek: +((count('held') + count('short')) / (windowDays / 7)).toFixed(1),
  };
}
