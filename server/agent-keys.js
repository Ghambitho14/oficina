// API key propia de un agente: SOLO desde el .env (nunca pasa por el panel ni por la base).
// Variable: AGENT_<ID>_API_KEY para Claude y AGENT_<ID>_<PROVEEDOR>_API_KEY para los demás (así cada key solo
// viaja a su proveedor), con el id en mayúsculas y lo que no sea letra o número como "_".
// Ej.: ciberseguridad → AGENT_CIBERSEGURIDAD_API_KEY · instagram-k3x9 con OpenCode → AGENT_INSTAGRAM_K3X9_OPENCODE_API_KEY
const up = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '_');
export const apiKeyVar = (id, provider = 'anthropic') => `AGENT_${up(id)}${provider === 'anthropic' ? '' : `_${up(provider)}`}_API_KEY`;
export const agentApiKey = (id, provider) => process.env[apiKeyVar(id, provider)] || '';
