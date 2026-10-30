import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { loadBrand } from './brand.js';
import './styles.css';

// Primero los nombres (para el login y el título), después la app.
loadBrand().then(() => createRoot(document.getElementById('root')).render(<App />));
