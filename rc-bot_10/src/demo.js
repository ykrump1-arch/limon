// Демо-режим: вымышленные резиденты для показа кому угодно.
// Включается переменной DEMO=1. Настоящие данные при этом не используются —
// демо-бот запускается отдельным сервисом со своим токеном и своей базой.

import * as db from './db.js';
import * as P from './progress.js';
import { tasksFor } from './catalog.js';

// имя, заезд, текущее задание, закрыто примеров в нём, трек
const DEMO = [
  ['Резидент А', '13.03', 'Бессилие', 4, 'main'],
  ['Резидент Б', '30.03', 'Иллюзии', 12, 'main'],
  ['Резидент В', '23.04', 'Иллюзии', 28, 'main'],
  ['Резидент Г', '20.05', 'Тяжёлые', 3, 'main'],
  ['Резидент Д', '02.07', 'Потери', 18, 'main'],
  ['Резидент Е', '16.07', 'Срыв 5', 6, 'sryv'],
  ['Резидент Ж', '22.07', '10 +/-', 14, 'main'],
  ['Резидент З', '06.08', '10 +/-', 9, 'main'],
  ['Резидент И', '15.08', 'Тесты', 20, 'main'],
];

const norm = (x) => String(x).toLowerCase().replace(/ё/g, 'е').replace(/[\s.,]/g, '');

export function seedDemo() {
  if (db.residents().length) return false;

  const year = new Date().getFullYear();
  for (const [name, date, taskName, done, track] of DEMO) {
    let started = P.parseDate(`${date}.${year}`);
    if (started > P.today()) started = P.parseDate(`${date}.${year - 1}`);

    const r = db.addResident({
      name, startedAt: started,
      dischargeAt: P.addMonths(started, track === 'sryv' ? 1 : 6),
    });
    r.track = track;

    const list = tasksFor(r);
    const q = norm(taskName);
    const task = list.find((t) => norm(t.short) === q)
      || list.find((t) => norm(t.short).includes(q) || norm(t.name).includes(q));
    if (!task) continue;

    const idx = list.indexOf(task);
    for (let i = 0; i < idx; i++) {
      const t = list[i];
      r.tasks[t.code] = {
        issuedAt: started, closedAt: P.today(),
        progress: Object.fromEntries(t.groups.map((g, gi) => [gi, new Array(g.count).fill(true)])),
      };
    }
    let left = done;
    r.tasks[task.code] = { issuedAt: P.today(), closedAt: null, progress: {} };
    task.groups.forEach((g, gi) => {
      const take = Math.max(0, Math.min(left, g.count));
      left -= take;
      r.tasks[task.code].progress[gi] = Array.from({ length: g.count }, (_, k) => k < take);
    });
  }
  db.flush();
  return true;
}
