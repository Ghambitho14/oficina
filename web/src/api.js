export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body && JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

export const STATUS = {
  ok: { label: 'Todo bien', color: 'var(--ok)' },
  warn: { label: 'Atención', color: 'var(--warn)' },
  crit: { label: 'Problema', color: 'var(--crit)' },
  pending: { label: 'Revisando…', color: 'var(--muted)' },
};

export const timeAgo = (iso) => {
  if (!iso) return 'nunca';
  const s = Math.round((Date.now() - new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'))) / 1000);
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
};
