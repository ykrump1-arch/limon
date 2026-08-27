// Справочник заданий. Два трека: основная программа и программа срыва.
// Всё приводится к одному виду: задание = список групп, группа = N единиц.
// Единица — один пример / вопрос / граница, который принимает консультант.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'tasks.json'), 'utf8')
);

function buildGroups(t) {
  switch (t.structure) {
    case 'spheres':
      return t.spheres.map((name) => ({ name, count: t.examples_per_sphere ?? 1 }));
    case 'blocks':
      return t.blocks.filter((b) => b.count > 0).map((b) => ({ name: b.name, count: b.count }));
    case 'two_parts':
      return t.parts.map((p) => ({
        name: p.name, count: p.count, where: p.where || null, labels: p.labels || null,
      }));
    case 'items':
      return [{ name: 'Пункты', count: t.items.length, labels: t.items }];
    default:
      return [{ name: t.name, count: t.units || 1 }];
  }
}

export const TASKS = raw.tasks.map((t) => {
  const groups = buildGroups(t);
  return { ...t, groups, units: groups.reduce((s, g) => s + g.count, 0) };
});

export const FORMATS = raw.formats;
export const PROGRAMS = raw.programs;
export const byCode = Object.fromEntries(TASKS.map((t) => [t.code, t]));

// Задания трека по порядку
export const TRACKS = {
  main: TASKS.filter((t) => t.track === 'main').sort((a, b) => a.order - b.order),
  sryv: TASKS.filter((t) => t.track === 'sryv').sort((a, b) => a.order - b.order),
};

export const TRACK_UNITS = {
  main: TRACKS.main.reduce((s, t) => s + t.units, 0),
  sryv: TRACKS.sryv.reduce((s, t) => s + t.units, 0),
};

export const TRACK_NAME = { main: 'Основная программа', sryv: 'Программа срыва' };

export const trackOf = (r) => (r.track === 'sryv' ? 'sryv' : 'main');
export const tasksFor = (r) => TRACKS[trackOf(r)];
export const unitsFor = (r) => TRACK_UNITS[trackOf(r)];

export function formatOf(task) {
  return FORMATS[task.format] || FORMATS.free;
}
