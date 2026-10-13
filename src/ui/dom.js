// Helpers de DOM sem framework.

export function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : String(f));
  }
  return el;
}

export const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export function baixarArquivo(nome, conteudo, tipo = 'application/json') {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = h('a', { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function abrirArquivo(accept = '.json') {
  return new Promise((resolve, reject) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return reject(new Error('Nenhum arquivo'));
      resolve(await f.text());
    });
    document.body.append(input);
    input.click();
  });
}

export function toast(msg, tipo = 'info', ms = 4000) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.append(box);
  }
  const el = h('div', { class: `toast ${tipo}` }, msg);
  box.append(el);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => el.classList.add('saindo'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

/** Campo numérico com rótulo e unidade. */
export function campoNumero({ rotulo, valor, passo = 'any', unidade, min, max, aoMudar, titulo }) {
  const input = h('input', { type: 'number', step: String(passo), value: valor, min, max, title: titulo });
  if (aoMudar) input.addEventListener('change', () => aoMudar(Number(input.value)));
  return {
    el: h('label', { class: 'campo', title: titulo }, h('span', {}, rotulo), input, unidade ? h('small', {}, unidade) : null),
    input,
  };
}

export function seletor(opcoes, valor, aoMudar) {
  const s = h(
    'select',
    {},
    Object.entries(opcoes).map(([v, t]) => h('option', { value: v, selected: v === valor }, t)),
  );
  s.addEventListener('change', () => aoMudar(s.value));
  return s;
}

export function interruptor(rotulo, valor, aoMudar, titulo) {
  const input = h('input', { type: 'checkbox', checked: !!valor });
  input.addEventListener('change', () => aoMudar(input.checked));
  return { el: h('label', { class: 'interruptor', title: titulo }, input, h('span', {}, rotulo)), input };
}
