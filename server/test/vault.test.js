// La memoria en Obsidian: qué escribe la Oficina, qué nunca toca y qué lee antes de diagnosticar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempDir, markdownFiles } from './helpers.js';

const vault = tempDir('vault');
process.env.OBSIDIAN_DIR = vault;
process.env.OBSIDIAN_MEMORY_NOTES = 'Servidor';
process.env.OBSIDIAN_HOME_NOTE = '00 Índice VPS';
process.env.SERVER_NAME = 'VPS';
process.env.TIMEZONE = 'UTC';

// Notas del dueño, fuera de la carpeta de la Oficina.
const own = {
  'Servidor.md': '---\ntags: [vps]\n---\n# Servidor\nEl backup corre a las 3 AM.\n',
  'Proyectos/Web.md': '# Web\nNo tocar.\n',
};
for (const [rel, text] of Object.entries(own)) {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
}
const sha = (rel) => crypto.createHash('sha1').update(fs.readFileSync(path.join(vault, rel))).digest('hex');
const before = Object.fromEntries(Object.keys(own).map((rel) => [rel, sha(rel)]));

const v = await import('../vault.js');
const ana = { id: 'informatica', name: 'Ana', role: 'Informática', description: 'Vigila el servidor', floor: 'infra', defaults: { role: 'Informática' } };
v.initVault({ agents: () => [{ ...ana, status: 'crit', open: 1 }], nameOf: (id) => (id === 'informatica' ? 'Ana' : id) });
const office = path.join(vault, 'Oficina');
const note = (rel) => fs.readFileSync(path.join(office, `${rel}.md`), 'utf8');

const cpu = (pct) => ({ severity: 'warn', title: `CPU alta: ${pct}%`, detail: 'Carga sostenida' });
const down = { severity: 'crit', title: 'Contenedor caído: api', detail: 'Exited (1)', resource: { type: 'contenedor', name: 'api' } };
const event = { id: 7, ts: Date.parse('2026-10-29T12:30:00Z'), kind: 'container_down', severity: 'crit', name: 'api', from_state: 'running', to_state: 'exited' };

test('clean deja nombres de archivo seguros', () => {
  assert.equal(v.clean('a/b\\c:d*e?"f"<g>|h#i^[j]'), 'a b c d e f g h i j');
  assert.equal(v.clean('   '), 'sin nombre');
  assert.equal(v.clean('x'.repeat(200)).length, 100);
});

test('una revisión con problemas crea hallazgos, recurso, alerta, área y nota central', () => {
  v.recordRun(ana, { report: { status: 'crit', findings: [cpu(91), down], aiSummary: 'Reinicia el contenedor api.' }, previous: null, events: [event] });
  const files = markdownFiles(office);
  assert.ok(files.includes('Hallazgos/CPU alta.md'), files.join(', '));
  assert.ok(files.includes('Hallazgos/Contenedor caído api.md'), files.join(', '));
  assert.ok(files.includes('Recursos/Contenedores/api.md'));
  assert.ok(files.includes('Áreas/Informática.md'));
  assert.ok(files.includes('VPS.md'));
  assert.ok(files.some((f) => f.startsWith('Alertas/2026-10-29 12.30 Contenedor caído api')), files.join(', '));

  const finding = note('Hallazgos/CPU alta');
  assert.match(finding, /estado: "abierto"/);
  assert.match(finding, /<!-- oficina:inicio -->/);
  assert.match(finding, /## Notas del dueño/);
  assert.match(finding, /Reinicia el contenedor api\./);
  // En la tabla de la nota central el "|" del enlace va escapado.
  assert.match(note('VPS'), /\[\[Oficina\/Áreas\/Informática\\\|Informática\]\]/);
  assert.match(note('VPS'), /\[\[00 Índice VPS\]\]/);
});

test('el mismo problema con otra medida no crea otra nota', () => {
  v.recordRun(ana, { report: { status: 'warn', findings: [cpu(93)] }, previous: { findings: [cpu(91), down] } });
  assert.equal(markdownFiles(office).filter((f) => f.startsWith('Hallazgos/CPU')).length, 1);
  assert.match(note('Hallazgos/Contenedor caído api'), /estado: "resuelto"/);
  assert.match(note('Áreas/Informática'), /✅ \[\[Oficina\/Hallazgos\/Contenedor caído api/);
  // El historial no arrastra los textos de relleno.
  assert.doesNotMatch(note('Áreas/Informática'), /Todavía nada/);
});

test('lo que escribe el dueño se conserva y entra en la memoria', () => {
  const file = path.join(office, 'Hallazgos/CPU alta.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nEs el backup de las 3 AM, es intencional.\n');
  const { text, ownerKey } = v.memoryFor(ana, [cpu(95)]);
  assert.match(text, /es intencional/);
  assert.match(text, /El backup corre a las 3 AM/, 'lee la nota "Servidor" de OBSIDIAN_MEMORY_NOTES');
  assert.match(ownerKey, /^[0-9a-f]{12}$/);

  v.recordRun(ana, { report: { status: 'warn', findings: [cpu(95)], aiSummary: 'Nuevo diagnóstico' }, previous: { findings: [cpu(93)] } });
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /es intencional/);
  assert.match(after, /Nuevo diagnóstico/);
  assert.equal(after.match(/## Notas del dueño/g).length, 1);

  // La clave cambia solo si el dueño escribe algo distinto.
  assert.equal(v.memoryFor(ana, [cpu(95)]).ownerKey, ownerKey);
  fs.appendFileSync(file, 'Otra indicación.\n');
  assert.notEqual(v.memoryFor(ana, [cpu(95)]).ownerKey, ownerKey);
});

test('lo que el dueño escribe arriba del bloque de la Oficina tampoco se pierde', () => {
  const file = path.join(office, 'Hallazgos/CPU alta.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- oficina:inicio -->', 'Lo puse arriba sin querer.\n<!-- oficina:inicio -->'));
  v.recordRun(ana, { report: { status: 'warn', findings: [cpu(96)] }, previous: { findings: [cpu(95)] } });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /Lo puse arriba sin querer\./);
  assert.match(text, /es intencional/);
});

test('sin notas del dueño, ownerKey va vacío', () => {
  assert.equal(v.memoryFor({ ...ana, defaults: { role: 'Otra área' } }, []).ownerKey, '');
});

test('la bitácora agrega líneas antes de las notas del dueño y solo de lo importante', () => {
  v.journal({ agent: 'informatica', kind: 'alerta', message: 'Se cayó\napi' });
  v.journal({ agent: 'informatica', kind: 'lectura', message: 'Leí métricas' });
  const [day] = markdownFiles(path.join(office, 'Bitácora'));
  const text = fs.readFileSync(path.join(office, 'Bitácora', day), 'utf8');
  assert.match(text, /\*\*Ana\*\* · Se cayó api\n<!-- oficina:fin -->/);
  assert.doesNotMatch(text, /Leí métricas/);
});

test('un título con ".." no escribe fuera de la carpeta de la Oficina', () => {
  v.recordRun(ana, { report: { status: 'warn', findings: [{ severity: 'warn', title: '../../../escape', detail: '' }] }, previous: null });
  for (const f of markdownFiles(vault)) assert.ok(f.startsWith('Oficina/') || f in own, `archivo inesperado: ${f}`);
});

test('las notas del dueño quedaron intactas', () => {
  for (const rel of Object.keys(own)) assert.equal(sha(rel), before[rel], rel);
});

test('eventResource reconoce contenedores y dominios', () => {
  assert.deepEqual(v.eventResource({ kind: 'container_down', name: 'api' }), { type: 'contenedor', name: 'api' });
  assert.deepEqual(v.eventResource({ kind: 'cert_expiring', name: 'example.com' }), { type: 'dominio', name: 'example.com' });
  assert.equal(v.eventResource({ kind: 'host_disk', name: 'host' }), null);
  assert.equal(v.eventResource({ kind: 'snort', name: 'snort' }), null);
});

test('los agentes de negocio no escriben en la bóveda', () => {
  const count = markdownFiles(office).length;
  v.recordRun({ ...ana, id: 'instagram', floor: 'negocio' }, { report: { status: 'warn', findings: [cpu(99)] } });
  assert.equal(markdownFiles(office).length, count);
});
