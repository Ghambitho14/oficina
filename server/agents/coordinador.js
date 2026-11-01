// Coordinador: el jefe de la oficina. Habla con el dueño por su chat privado de Telegram (y por el chat del panel),
// le pregunta al equipo, pide revisiones y, si algo es difícil, propone pasárselo a Claude Code.
// Aquí solo está el puesto; lo que piensa y sus herramientas están en coordinador.js.
export default {
  id: 'coordinador',
  floor: 'negocio',
  schedule: 'manual',

  parseInput: () => ({ error: 'Al coordinador se le habla por Telegram o por el chat' }),

  async run() {
    return { findings: [], metrics: {} };
  },
};
