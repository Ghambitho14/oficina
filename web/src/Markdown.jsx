import { useState } from 'react';

// Markdown básico de las respuestas de la IA: párrafos, títulos, listas, **negrita**, *cursiva*, `código` y bloques ```.
// Se arma con elementos de React (nunca HTML inyectado): un texto raro del modelo no puede romper ni ejecutar nada.

// La cursiva con _ solo cuenta fuera de una palabra: LOCAL_CHECKS o SSH_HOST no se vuelven cursiva.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s\n][^*\n]*\*|(?<!\w)_[^_\s\n][^_\n]*_(?!\w))/g;

function inline(text) {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={i}>{inline(part.slice(2, -2))}</strong>;
    return <em key={i}>{part.slice(1, -1)}</em>;
  });
}

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // sin permiso para el portapapeles (http sin HTTPS): el texto se puede seleccionar a mano
    }
  };
  return (
    <div className="md-code">
      <pre>
        <code>{code}</code>
      </pre>
      <button type="button" className="ghost small-btn" onClick={copy}>
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

const ITEM = /^\s*(\d+[.)]|[-*•])\s+(.*)$/;

// Agrupa las líneas en bloques: código, lista (numerada o no), título o párrafo.
function blocks(text) {
  const out = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i]);
      out.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      out.push({ type: 'gap' });
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      out.push({ type: 'heading', text: heading[1] });
      continue;
    }
    const item = line.match(ITEM);
    const last = out.at(-1);
    if (item) {
      const ordered = /\d/.test(item[1]);
      // Los modelos suelen dejar una línea en blanco entre "1." y "2.": sigue siendo la misma lista.
      while (out.at(-1)?.type === 'gap') out.pop();
      const list = out.at(-1);
      if (list?.type === 'list' && list.ordered === ordered) list.items.push([item[2]]);
      else out.push({ type: 'list', ordered, start: ordered ? parseInt(item[1], 10) : 1, items: [[item[2]]] });
      continue;
    }
    // Una línea con sangría después de un ítem es parte de ese ítem (p. ej. "   *Comando:* …").
    if (last?.type === 'list' && /^\s+/.test(line)) last.items.at(-1).push(line.trim());
    else if (last?.type === 'para') last.lines.push(line.trim());
    else out.push({ type: 'para', lines: [line.trim()] });
  }
  return out.filter((b) => b.type !== 'gap');
}

const lines = (list) => list.map((l, i) => (i ? [<br key={i} />, inline(l)] : inline(l)));

export default function Markdown({ text }) {
  return (
    <div className="md">
      {blocks(text || '').map((b, i) => {
        if (b.type === 'code') return <CodeBlock key={i} code={b.text} />;
        if (b.type === 'heading') return <p key={i} className="md-heading">{inline(b.text)}</p>;
        if (b.type === 'para') return <p key={i}>{lines(b.lines)}</p>;
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((item, j) => (
              <li key={j}>{lines(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
