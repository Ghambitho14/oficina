// Agente de contenido: arma ideas de publicaciones para Instagram cuando se lo pides. Nunca publica nada.
import { callAi, jsonOf, AiUnavailable, aboutBusiness, personaOf } from '../ai.js';
import { config } from '../config.js';

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
  // Lo que sabe de su oficio: va en sus instrucciones para la IA (diagnóstico y chat).
  expertise: 'Tu especialidad: Instagram para negocios pequeños. Ganchos que detienen el scroll, formatos que funcionan (Reels cortos, carruseles que enseñan algo, historias con encuestas o preguntas), textos que suenan a persona y no a anuncio, y piezas que se pueden producir con un celular.',
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
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system:
          `Eres ${ctx.agent.name}, a cargo del contenido de Instagram${config.brand.org ? ` de ${config.brand.org}` : ''}. ${ctx.agent.expertise}\n\n` +
          'Cómo armas las ideas:\n' +
          '- Cada idea nace de algo real del negocio (lo que vende, a quién, cómo trabaja): si cambias el nombre del negocio por ' +
          'otro y la idea sigue sirviendo, es demasiado genérica.\n' +
          '- Las 5 ideas son distintas entre sí: mezcla enseñar algo, mostrar el detrás de escena, prueba social (clientes, ' +
          'resultados) y vender directo, sin que más de una sea venta directa.\n' +
          '- "gancho": lo primero que se lee o se escucha, máximo 12 palabras. Una pregunta, un dato o una promesa concreta; ' +
          'nunca "¿Sabías que…?" ni "Descubre…".\n' +
          '- "texto": listo para copiar y pegar. Frases cortas, como habla el cliente, sin mayúsculas gritadas ni más de 3 emojis, ' +
          'y termina con una sola llamada a la acción clara (escribir por DM, comentar una palabra, guardar el post…).\n' +
          '- "hashtags": de 3 a 8, del rubro y de la ciudad o zona si se sabe; nada de #love, #instagood ni #follow.\n' +
          '- "visual": no generas imágenes; dejas la pauta para que otra persona la arme con un celular. En un carrusel, qué va ' +
          'en cada slide; en un reel, las tomas en orden con su duración. Si tienes una guía de marca, nombra su estilo, el ' +
          'formato con sus medidas, el titular y la foto.\n' +
          '- "cuando": día y hora concretos y por qué (cuándo está mirando su cliente).\n' +
          '- No inventes precios, promociones, testimonios ni cifras del negocio: si la idea los necesita, deja [entre corchetes] ' +
          'lo que el dueño tiene que completar.' +
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
