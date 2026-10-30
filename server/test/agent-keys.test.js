import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyVar, agentApiKey } from '../agent-keys.js';

test('el nombre de la variable sale del id del agente', () => {
  assert.equal(apiKeyVar('ciberseguridad'), 'AGENT_CIBERSEGURIDAD_API_KEY');
  assert.equal(apiKeyVar('instagram-k3x9'), 'AGENT_INSTAGRAM_K3X9_API_KEY');
  assert.equal(apiKeyVar('a.b c'), 'AGENT_A_B_C_API_KEY');
});

test('cada proveedor que no es Claude tiene su propia variable', () => {
  assert.equal(apiKeyVar('ciberseguridad', 'anthropic'), 'AGENT_CIBERSEGURIDAD_API_KEY');
  assert.equal(apiKeyVar('instagram-k3x9', 'opencode'), 'AGENT_INSTAGRAM_K3X9_OPENCODE_API_KEY');
  process.env.AGENT_PRUEBA_X2_API_KEY = 'sk-fake-claude';
  assert.equal(agentApiKey('prueba-x2', 'opencode'), '', 'la key de Claude nunca viaja a otro proveedor');
});

test('lee la key del entorno y devuelve vacío si no está', () => {
  process.env.AGENT_PRUEBA_X1_API_KEY = 'sk-fake-1';
  assert.equal(agentApiKey('prueba-x1'), 'sk-fake-1');
  assert.equal(agentApiKey('no-existe'), '');
});
