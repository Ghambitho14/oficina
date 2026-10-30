// Nombres de la app, del negocio y del servidor: vienen del servidor (APP_NAME, ORG_NAME, SERVER_NAME)
// y se cargan antes de dibujar la app. Aquí no hay nada fijo: estos son solo los valores si el servidor no responde.
export const brand = { app: 'Oficina', org: '', server: 'Servidor' };

export async function loadBrand() {
  try {
    const res = await fetch('/api/branding');
    if (res.ok) Object.assign(brand, await res.json());
  } catch {
    // sin conexión: se quedan los nombres genéricos
  }
  document.title = brand.app;
}
