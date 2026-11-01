// Agente de contenido: arma ideas de publicaciones para Instagram cuando se lo pides. Nunca publica nada.
import { callAi, jsonOf, AiUnavailable, aboutBusiness, effortOf, personaOf, whoIs, rulesOf } from '../ai.js';

const FORMATS = ['Reel', 'Carrusel', 'Post', 'Historia'];
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'formato', 'gancho', 'texto', 'hashtags', 'visual', 'cuando'],
        properties: {
          titulo: { type: 'string', description: 'Nombre corto de la idea' },
          formato: { type: 'string', enum: FORMATS },
          gancho: { type: 'string', description: 'Primera frase o primeros 2 segundos que detienen el scroll' },
          texto: { type: 'string', description: 'Texto completo de la publicación, listo para copiar' },
          hashtags: { type: 'array', items: { type: 'string' } },
          visual: { type: 'string', description: 'Qué mostrar: imagen, slides del carrusel o guion del reel. Si hay guía de marca: estilo, medidas, titular y foto' },
          cuando: { type: 'string', description: 'Mejor día y hora para publicarla y por qué' },
        },
      },
    },
  },
};

export default {
  id: 'instagram',
  floor: 'negocio',
  schedule: 'manual',

  parseInput(raw = {}) {
    const formato = FORMATS.includes(raw.formato) ? raw.formato : 'Cualquiera';
    return { tema: text(raw.tema, 200), objetivo: text(raw.objetivo, 200), formato };
  },

  async run(ctx) {
    const { tema, objetivo, formato } = ctx.input;
    const findings = [];
    const brief = aboutBusiness();
    ctx.log(`Empecé a pensar ideas${tema ? ` sobre «${tema}»` : ''}${formato !== 'Cualquiera' ? ` en formato ${formato}` : ''}`);

    try {
      const response = await callAi({
        agent: ctx.agent,
        purpose: 'ideas',
        max_tokens: 5000,
        output_config: { effort: effortOf(ctx.agent), format: { type: 'json_schema', schema: SCHEMA } },
        system:
          `${whoIs(ctx.agent)}\n\n` +
          'Reglas fijas:\n' +
          '- No generas imágenes: en "visual" dejas la pauta para que otra persona arme la pieza.\n' +
          '- No inventes precios, promociones, testimonios ni cifras del negocio: si la idea los necesita, deja [entre corchetes] ' +
          'lo que el dueño tiene que completar.' +
          rulesOf(ctx.agent.instructions, 'Cómo armas las ideas') +
          personaOf(ctx.agent),
        messages: [
          {
            role: 'user',
            content:
              `Sobre el negocio:\n${brief}\n\n` +
              `Arma 5 ideas de publicaciones.${tema ? `\nTema: ${tema}` : ''}${objetivo ? `\nObjetivo: ${objetivo}` : ''}` +
              `${formato !== 'Cualquiera' ? `\nFormato: todas en ${formato}` : '\nMezcla formatos.'}`,
          },
        ],
      });
      if (response.stop_reason === 'refusal') throw new Error('La IA no quiso generar ese contenido. Prueba con otro tema.');
      if (response.stop_reason === 'max_tokens') throw new Error('La respuesta se cortó. Intenta de nuevo con un tema más acotado.');
      // Los modelos locales a veces se saltan campos: cada idea se completa para que el panel no se rompa.
      const raw = jsonOf(response).ideas;
      if (!Array.isArray(raw) || !raw.length) throw new Error('La respuesta no trajo ideas. Prueba de nuevo o con otro modelo.');
      const ideas = raw.slice(0, 5).map((i) => ({
        titulo: text(i.titulo, 120) || 'Idea',
        formato: FORMATS.includes(i.formato) ? i.formato : formato !== 'Cualquiera' ? formato : 'Post',
        gancho: text(i.gancho, 300),
        texto: text(i.texto, 3000),
        hashtags: (Array.isArray(i.hashtags) ? i.hashtags : []).filter((h) => typeof h === 'string').slice(0, 8),
        visual: text(i.visual, 1000),
        cuando: text(i.cuando, 300),
      }));
      ctx.log(`Generé ${ideas.length} ideas: ${ideas.map((i) => i.titulo).join(' · ')}`);
      return { findings, metrics: { input: ctx.input, ideas } };
    } catch (err) {
      const why = err instanceof AiUnavailable ? err.message : `No pude generar las ideas: ${err.message}`;
      findings.push({ severity: 'warn', title: 'No hubo ideas esta vez', detail: why });
      return { findings, metrics: { input: ctx.input, ideas: [], error: why } };
    }
  },
};
