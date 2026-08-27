// Каталог заданий.
// Задания в tasks.json описаны по-разному (сферы, блоки, пункты, две части).
// Здесь всё приводится к одному виду: задание = список групп, группа = N единиц.
// Единица — один пример / вопрос / граница, который принимает консультант.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'tasks.json'), 'utf8')
);

function buildGroups(task) {
  switch (task.structure) {
    case 'spheres':
      return task.spheres.map((name) => ({
        name,
        count: task.examples_per_sphere ?? 1,
      }));

    case 'blocks':
      return task.blocks
        .filter((b) => b.count > 0)
        .map((b) => ({ name: b.name, count: b.count }));

    case 'two_parts':
      return task.parts.map((p) => ({
        name: p.name,
        count: p.count,
        where: p.where || null,
      }));

    case 'items':
      return [{ name: 'Пункты', count: task.items.length, labels: task.items }];

    default:
      return [{ name: task.name, count: task.units || 1 }];
  }
}

export const TASKS = raw.tasks.map((t) => {
  const groups = buildGroups(t);
  return {
    ...t,
    groups,
    units: groups.reduce((s, g) => s + g.count, 0),
  };
});

export const PROGRAM = raw.program;
export const FORMATS = raw.formats;

export const byCode = Object.fromEntries(TASKS.map((t) => [t.code, t]));

export const TOTAL_UNITS = TASKS.reduce((s, t) => s + t.units, 0);

// Порядок выдачи заданий — по полю order, выписное идёт последним
export const ORDERED = [...TASKS].sort((a, b) => a.order - b.order);

export function formatOf(task) {
  return FORMATS[task.format] || FORMATS.free;
}
