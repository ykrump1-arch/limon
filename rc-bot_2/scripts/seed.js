// Демо-данные для показа. Имена вымышленные.
// Запуск: node scripts/seed.js
import * as db from '../src/db.js';
import { ORDERED, byCode } from '../src/catalog.js';
import * as P from '../src/progress.js';

const NAMES = ['Резидент А', 'Резидент Б', 'Резидент В', 'Резидент Г', 'Резидент Д'];
const CONTEXTS = ['mg', 'mg', 'mg', 'ks', 'ind'];
const DAY = 86400000;

db.load();

NAMES.forEach((name, n) => {
  const started = new Date(Date.now() - (30 + n * 35) * DAY).toISOString().slice(0, 10);
  const r = db.addResident({ name, startedAt: started });

  // выдаём задания по порядку и частично закрываем
  const howMany = 1 + n;
  for (let i = 0; i < howMany; i++) {
    const task = ORDERED[i];
    r.tasks[task.code] = { issuedAt: started, closedAt: null, progress: {} };
    r.activeTask = task.code;

    const full = i < howMany - 1;                 // прошлые задания закрываем целиком
    task.groups.forEach((g, gi) => {
      const take = full ? g.count : Math.floor(Math.random() * (g.count + 1));
      r.tasks[task.code].progress[gi] = Array.from({ length: g.count }, (_, k) => k < take);
      for (let k = 0; k < take; k++) {
        const ago = Math.floor(Math.random() * 25);
        db.logAll().push({
          ts: new Date(Date.now() - ago * DAY).toISOString(),
          action: 'accept',
          residentId: r.id, taskCode: task.code, groupIdx: gi, unitIdx: k,
          by: 0, byName: 'демо',
          context: CONTEXTS[Math.floor(Math.random() * CONTEXTS.length)],
        });
      }
    });
    if (full) r.tasks[task.code].closedAt = started;
  }
});

// отметки МГ за месяц: часть отменена, часть сокращена
for (let i = 0; i < 30; i++) {
  const d = new Date(Date.now() - i * DAY);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) continue;
  const roll = Math.random();
  db.markMg({
    date: d.toISOString().slice(0, 10),
    status: roll < 0.15 ? 'cancelled' : roll < 0.35 ? 'short' : 'held',
    by: 0,
  });
}

db.flush();
console.log('Демо-данные записаны.');
for (const r of db.residents()) {
  const o = P.overall(r);
  const f = P.forecast(r);
  console.log(
    `${r.name}: день ${P.dayOfProgram(r)}, ${o.percent}% (${o.done}/${o.total}), ` +
    `в работе ${r.activeTask ? byCode[r.activeTask].short : '—'}, прогноз ${f.status}`
  );
}
console.log('\nПо дому:', P.houseStats(30));
console.log('МГ:', P.mgStats(db.events(), 30));
