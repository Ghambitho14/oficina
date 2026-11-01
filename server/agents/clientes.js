// Buscador de clientes: busca en la web negocios que podrían necesitar los servicios del negocio (ORG_NAME / "Sobre tu negocio").
// Solo negocios y datos de contacto públicos del negocio. No contacta a nadie: tú decides qué hacer con la lista.
import { config } from '../config.js';
import { callAi, textOf, AiUnavailable, aboutBusiness, effortOf, personaOf, whoIs, rulesOf } from '../ai.js';
import { addLeads, knownLeadNames, listLeads } from '../db.js';

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const safeUrl = (v) => (/^https?:\/\/[^\s]+$/i.test(v || '') ? v.slice(0, 300) : '');

// Herramienta "estricta" para recibir la lista ya estructurada al final de la búsqueda.
const SAVE_TOOL = {
  name: 'guardar_prospectos',
  description: 'Guarda la lista final de negocios encontrados. Llámala una sola vez, cuando termines de buscar.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['resumen', 'prospectos'],
    properties: {
      resumen: { type: 'string', description: '1 o 2 frases sobre cómo fue la búsqueda' },
      prospectos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nombre', 'web', 'ciudad', 'rubro', 'motivo', 'contacto', 'fuente'],
          properties: {
            nombre: { type: 'string' },
            web: { type: 'string', description: 'URL de su página, o "" si no tiene' },
            ciudad: { type: 'string' },
            rubro: { type: 'string' },
            motivo: { type: 'string', description: 'Por qué podría necesitar el servicio (concreto, basado en lo que viste)' },
            contacto: { type: 'string', description: 'Teléfono o email COMERCIAL publicado por el negocio, o ""' },
            fuente: { type: 'string', description: 'URL donde encontraste el negocio' },
          },
        },
      },
    },
  },
};

export default {
  id: 'clientes',
  floor: 'negocio',
  schedule: 'manual',
  dailyLimit: config.ai.leadsPerDay,
  // Busca con la búsqueda web de Claude: solo admite modelos de Anthropic. Sin modelo propio usa LEADS_MODEL.
  webSearch: true,
  defaultModel: config.ai.leadsModel,

  // En el chat, el buscador conoce la lista de prospectos (sin contactos) para poder opinar sobre ella.
  chatContext: () =>
    listLeads()
      .slice(0, 30)
      .map(({ name, city, category, status, reason }) => ({ name, city, category, status, reason })),

  parseInput(raw = {}) {
    const input = {
      rubro: text(raw.rubro, 100),
      zona: text(raw.zona, 100),
      servicio: text(raw.servicio, 200),
      cantidad: Math.min(15, Math.max(3, Number(raw.cantidad) || 8)),
    };
    if (!input.rubro || !input.zona) return { error: 'Indica al menos el rubro y la zona' };
    return input;
  },

  async run(ctx) {
    const { rubro, zona, servicio, cantidad } = ctx.input;
    const search = `${rubro} en ${zona}`;
    const findings = [];
    ctx.log(`Empecé a buscar ${rubro} en ${zona}${servicio ? ` para ofrecer ${servicio}` : ''}`);

    const known = knownLeadNames();
    const messages = [
      {
        role: 'user',
        content:
          `Sobre nosotros:\n${aboutBusiness()}\n\n` +
          `Busca hasta ${cantidad} negocios reales del rubro "${rubro}" en "${zona}" que podrían necesitar ${servicio || 'nuestros servicios'}.` +
          (known.length ? `\nYa los tenemos, no los repitas: ${known.join(', ')}.` : '') +
          '\nAl terminar, llama a guardar_prospectos con la lista.',
      },
    ];

    try {
      let response;
      // La búsqueda corre en el servidor de Anthropic; si se pausa (pause_turn), se le pide que siga.
      for (let round = 0; round < 3; round++) {
        response = await callAi({
          agent: ctx.agent,
          purpose: 'clientes',
          max_tokens: 8000,
          output_config: { effort: effortOf(ctx.agent) },
          system:
            `${whoIs(ctx.agent)}\n\n` +
            'Reglas fijas:\n' +
            '- Usa la búsqueda web para encontrar negocios REALES que sigan funcionando. Si no viste el negocio en una fuente, no va.\n' +
            '- Solo negocios, nunca personas particulares. Del contacto, solo el teléfono o email comercial que el propio ' +
            'negocio publica: nada de perfiles personales, datos privados ni direcciones de casas.\n' +
            '- Nunca adivines una URL ni un teléfono: si no encontraste su web, "web" queda vacía (y eso mismo puede ser el motivo).\n' +
            '- Al terminar, llama una sola vez a guardar_prospectos.' +
            rulesOf(ctx.agent.instructions, 'Cómo buscas') +
            personaOf(ctx.agent),
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: config.ai.leadsSearches }, SAVE_TOOL],
          messages,
        });
        if (response.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: response.content });
      }

      if (response.stop_reason === 'refusal') throw new Error('La IA no quiso hacer esa búsqueda. Prueba con otro rubro o zona.');
      const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'guardar_prospectos');
      if (!call) {
        const said = textOf(response).slice(0, 300);
        findings.push({ severity: 'warn', title: 'La búsqueda terminó sin una lista', detail: said || 'Intenta con una zona o rubro más concreto.' });
        return { findings, metrics: { input: ctx.input, found: 0, added: 0, summary: said } };
      }

      const leads = (call.input.prospectos || []).slice(0, cantidad).map((l) => ({
        name: text(l.nombre, 120),
        website: safeUrl(l.web),
        city: text(l.ciudad, 80) || zona,
        category: text(l.rubro, 80) || rubro,
        reason: text(l.motivo, 300),
        contact: text(l.contacto, 120),
        source: safeUrl(l.fuente),
      })).filter((l) => l.name);
      const added = addLeads(leads, search);
      ctx.log(`Encontré ${leads.length} negocios de ${rubro} en ${zona}; ${added} son nuevos en la lista`);
      if (!added) findings.push({ severity: 'info', title: 'No hubo prospectos nuevos', detail: 'Los que encontró ya estaban en tu lista. Prueba otra zona o rubro.' });
      return { findings, metrics: { input: ctx.input, found: leads.length, added, summary: text(call.input.resumen, 400) } };
    } catch (err) {
      const why = err instanceof AiUnavailable ? err.message : `No pude buscar: ${err.message}`;
      findings.push({ severity: 'warn', title: 'La búsqueda falló', detail: why });
      return { findings, metrics: { input: ctx.input, found: 0, added: 0, error: why } };
    }
  },
};
