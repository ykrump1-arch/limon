// Разбор отчётов МГ, написанных живым текстом в чате.
// Никакого ИИ — нотация достаточно устойчивая, чтобы разобрать правилами.
//
// Понимает, например:
//   Рухсора - иллюзия сф6 пр1, пр2 сдал ✅
//   Жавохир - Потери 2 сфера 1-2 примеры закрыл
//   Азиз Р. - потери : 9/2, 9/3
//   Илья - тест : закрыл задание полностью
//   Элёр - (+/-) 1пр,5пр сдал ✅  пр2,3,4 переписать ❌   ← второе не засчитывает

import { tasksFor } from './catalog.js';

// Имена в чате пишут по-разному: Шерзод/Шерзодбек, Махир/Мохир, Эркин/Еркин.
// Приводим к общему виду: ё→е, э→е, о→а, мягкие знаки долой.
export function normName(s) {
  return String(s).toLowerCase().trim()
    .replace(/[ёе]/g, 'е').replace(/э/g, 'е')
    .replace(/[оа]/g, 'а')
    .replace(/[ьъ]/g, '')
    .replace(/[^a-zа-я0-9]/g, '');
}

export function normTask(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[\s.,]/g, '');
}

// --- поиск резидента ---
export function findResident(name, residents) {
  const q = normName(name);
  if (q.length < 3) return null;
  let hit = residents.find((r) => normName(r.name) === q);
  if (hit) return hit;
  const pref = residents.filter((r) => {
    const n = normName(r.name);
    return (n.startsWith(q) || q.startsWith(n)) && Math.min(n.length, q.length) >= 5;
  });
  return pref.length === 1 ? pref[0] : null;
}

// --- поиск задания ---
const TASK_WORDS = [
  [/сры?в\s*(\d+)/i, (m, r) => `Срыв ${m[1]}`],
  [/иллюзи/i, () => 'Иллюзии'],
  [/бессили/i, () => 'Бессилие'],
  [/потер/i, () => 'Потери'],
  [/неуправл/i, () => 'Неуправляемость'],
  [/тяж|дно/i, () => 'Тяжёлые'],
  [/тест/i, () => 'Тесты'],
  [/субличн/i, () => 'Субличность'],
  [/ихз|история/i, () => 'ИХЗ'],
  [/границ|\bгб\b/i, () => 'ГБ'],
  [/выписн/i, () => 'Выписное'],
  [/сценар/i, () => 'Сценарий'],
  [/\+\s*[/\\–—-]?\s*[-−]|плюс|минус/i, () => '10 +/-'],
];

export function findTask(text, resident) {
  const list = tasksFor(resident);
  for (const [re, make] of TASK_WORDS) {
    const m = text.match(re);
    if (!m) continue;
    const want = normTask(make(m));
    const exact = list.find((t) => normTask(t.short) === want);
    if (exact) return exact;
    const part = list.filter((t) => normTask(t.short).includes(want) || normTask(t.name).includes(want));
    if (part.length) return part.sort((a, b) => a.short.length - b.short.length)[0];
  }
  return null;
}

// --- какая группа внутри задания ---
function pickGroup(task, text) {
  // «10 +/-»: плюсы или минусы
  if (task.groups.length === 2 && /плюс/i.test(task.groups[0].name)) {
    if (/минус|\(\s*[-−]\s*\)|\(\s*[-−]/i.test(text)) return 1;
    return 0;
  }
  return null;
}

// разворачивает «1-4» и «1,2,3» в [1,2,3,4]
function expand(str) {
  const out = [];
  for (const part of str.split(/[,;]/)) {
    const rng = part.match(/(\d+)\s*[-–—]\s*(\d+)/);
    if (rng) {
      for (let i = +rng[1]; i <= +rng[2]; i++) out.push(i);
      continue;
    }
    const one = part.match(/\d+/);
    if (one) out.push(+one[0]);
  }
  return [...new Set(out)];
}

// --- разбор одной строки ---
export function parseLine(line, residents) {
  const raw = line.trim().replace(/^\d+[).\s]+/, '');   // убираем нумерацию
  if (!raw || /^мг\b/i.test(raw)) return null;

  const split = raw.match(/^(.+?)\s*[-—–:]\s*(.+)$/);
  if (!split) return { raw, error: 'не понял строку' };

  const resident = findResident(split[1], residents);
  if (!resident) return { raw, name: split[1].trim(), error: 'нет такого резидента' };

  let tail = split[2];

  // отбрасываем всё, что отправили переписывать
  if (/перепис|❌/i.test(tail)) {
    const parts = tail.split(/(?<=[✅❌])|(?=перепис)/i);
    tail = parts.filter((p) => !/перепис|❌/i.test(p)).join(' ');
    if (!tail.trim()) return { raw, resident, error: 'всё отправлено на переписывание' };
  }

  const task = findTask(raw, resident);
  if (!task) return { raw, resident, error: 'не понял задание' };

  const units = [];                       // [groupIdx, unitIdx]
  const add = (g, u) => {
    if (g < 0 || g >= task.groups.length) return;
    if (u < 1 || u > task.groups[g].count) return;
    units.push([g, u - 1]);
  };
  const all = (g) => { for (let i = 1; i <= task.groups[g].count; i++) add(g, i); };

  const hint = pickGroup(task, tail);
  const many = task.groups.length > 1 && hint === null;
  let used = false;

  // задание закрыто целиком
  if (/закрыл[а]?\s+(задание|полностью)|задание\s+закрыл|полностью/i.test(tail)) {
    task.groups.forEach((_, gi) => all(gi));
    return { raw, resident, task, units, whole: true };
  }

  // «2 сферу закрыл» — сфера целиком. Внимание: \w не ловит кириллицу, нужен [а-яё]
  for (const m of tail.matchAll(/(\d+)\s*сфер[а-яё]*\s*закрыл/gi)) {
    used = true;
    all(+m[1] - 1);
  }

  // «плюсы закрыл» — группа целиком
  if (!used && hint !== null && /закрыл/i.test(tail) && !/\d/.test(tail.replace(/\d{1,2}\.\d{1,2}/g, ''))) {
    used = true;
    all(hint);
  }

  // «сф6 пр1, пр2» и «сф2. пр1, пр2»
  for (const m of tail.matchAll(/сф\.?\s*(\d+)((?:[.\s,]*пр\.?\s*\d+)+)/gi)) {
    used = true;
    for (const u of expand(m[2])) add(+m[1] - 1, u);
  }

  // «8 сфера 1-4 примеры», «2 сфера 4 пример»
  for (const m of tail.matchAll(/(\d+)\s*сфер[а-яё]*\s*([\d\s,\-–—]+?)\s*пример/gi)) {
    used = true;
    for (const u of expand(m[2])) add(+m[1] - 1, u);
  }

  // «9/2, 9/3» — сфера/пример
  for (const m of tail.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    used = true;
    add(+m[1] - 1, +m[2]);
  }

  // «потеря закрыл» без единой цифры — задание целиком
  if (!used && /закрыл/i.test(tail) && !/\d/.test(tail.replace(/\d{1,2}\.\d{1,2}/g, ''))) {
    task.groups.forEach((_, gi) => all(gi));
    return { raw, resident, task, units, whole: true };
  }

  // просто номера примеров: «4,5,6», «1пр,5пр», «7-10 примеры»
  if (!used) {
    if (many) return { raw, resident, task, error: 'не понял, к какой сфере' };
    // выкидываем только даты вида 25.08 — диапазоны «1-3» трогать нельзя
    const nums = tail.replace(/\b\d{1,2}\.\d{1,2}(\.\d{2,4})?\b/g, '');
    for (const u of expand(nums)) add(hint ?? 0, u);
  }

  if (!units.length) return { raw, resident, task, error: 'не нашёл номеров примеров' };
  return { raw, resident, task, units: [...new Map(units.map((u) => [u.join(':'), u])).values()] };
}

export function parseReport(text, residents) {
  const rows = [];
  for (const line of text.split('\n')) {
    const clean = line.replace(/^\[.*?\]\s*[^:]{0,30}:\s*/, '').trim();   // убираем «[дата] Автор:»
    if (!clean) continue;
    const r = parseLine(clean, residents);
    if (r) rows.push(r);
  }
  return rows;
}
