// Импорт списка резидентов с доски. Запуск: node scripts/import-board.js
import * as db from '../src/db.js';
import * as P from '../src/progress.js';

// Имя, дата заезда, трек. Год подставляется 2026.
const BOARD = `
Умид 13.03
Шерзодбек 14.03
Абдукодир 30.03
Сабрина 03.04
Мохир 08.04
Шомансур 13.04
Рухсора 17.04
Бобурхон 20.04
Шахзод 23.04
Хумоюн 12.05
Азизхужа 13.05
Мурод 15.05
Асадулло 20.05
Санжар 1 02.07
Навохир 15.07
Азизхон 16.07 срыв
Бахтиёр 21.07
Еркин 22.07
Санжар 2 27.07
Нозим 04.08
Эльёр 06.08
Атабек 08.08
Азиз Х. 08.08
Дилшод 12.08 срыв
Илья 15.08
`;

db.load();
let n = 0;
for (const line of BOARD.trim().split('\n')) {
  const parts = line.trim().split(/\s+/);
  let track = 'main';
  if (/^срыв$/i.test(parts.at(-1))) { track = 'sryv'; parts.pop(); }
  const date = P.parseDate(parts.at(-1) + '.2026');
  const name = parts.slice(0, -1).join(' ');
  if (!date || !name) { console.log('пропуск:', line); continue; }
  const r = db.addResident({
    name, startedAt: date,
    dischargeAt: P.addMonths(date, track === 'sryv' ? 1 : 6),
  });
  r.track = track;
  n++;
}
db.flush();
console.log(`Импортировано: ${n}`);
for (const r of db.residents()) {
  const s = P.status(r);
  console.log(`${s.icon} ${r.name.padEnd(12)} ${P.fmtDate(r.startedAt)} → ${P.fmtDate(r.dischargeAt)}  день ${String(P.dayOfProgram(r)).padStart(3)}  ${s.percent}%`);
}
