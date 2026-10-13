// Converte o STEP do braço em public/modelos/braco.glb, com um nó por corpo rígido
// (fixo, torre, ombro, cotovelo, punho) já no referencial da sua junta.
//
// Uso: npm run importar-step -- "C:/caminho/braço.step"
//
// Como separa as peças, sem depender de nomes:
// 1. Acha os 4 conjuntos motor+redutor (nós com muitas malhas) e, em cada um, o flange de
//    saída (peça ~45 × 45 × 11 mm). O centro do flange dá o eixo da junta; a dimensão fina,
//    a direção do eixo. O redutor com eixo perpendicular aos outros três é o da base.
// 2. Ordena a cadeia: ombro é o mais perto do eixo da base, depois cotovelo, depois punho.
// 3. Cada conjunto pertence ao corpo anterior da cadeia; o flange, ao corpo seguinte.
// 4. As demais peças vão para o corpo com que têm mais contato (vértices a < 0,8 mm),
//    repetindo até não sobrar peça encostada em nada (o resto fica fixo).
// 5. Calcula a geometria (offset do ombro, altura, L1, L2) e a pose em que o CAD está,
//    e leva cada peça para o referencial local da sua junta na pose zero.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrada = process.argv[2];
const saida = process.argv[3] ?? resolve(raiz, 'public/modelos/braco.glb');
if (!entrada) {
  console.error('Uso: npm run importar-step -- "caminho/do/arquivo.step" [saida.glb]');
  process.exit(1);
}

const GRUPOS = ['fixo', 'torre', 'ombro', 'cotovelo', 'punho'];
const GRAUS = 180 / Math.PI;

// ---- vetores -------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const escala = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norma = (a) => Math.hypot(...a);
const unit = (a) => escala(a, 1 / norma(a));

function caixa(p) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3)
    for (let d = 0; d < 3; d++) {
      if (p[k + d] < mn[d]) mn[d] = p[k + d];
      if (p[k + d] > mx[d]) mx[d] = p[k + d];
    }
  return { mn, mx, centro: mn.map((v, d) => (v + mx[d]) / 2), dim: mx.map((v, d) => v - mn[d]) };
}

/** Quantos vértices de `a` estão a menos de `tol` de algum vértice do índice espacial. */
function indice(pontos, tol) {
  const H = new Map();
  const chave = (x, y, z) => `${Math.floor(x / tol)},${Math.floor(y / tol)},${Math.floor(z / tol)}`;
  for (const p of pontos)
    for (let k = 0; k < p.length; k += 3) {
      const c = chave(p[k], p[k + 1], p[k + 2]);
      if (!H.has(c)) H.set(c, []);
      H.get(c).push(p[k], p[k + 1], p[k + 2]);
    }
  return (a) => {
    let n = 0;
    for (let k = 0; k < a.length; k += 3) {
      const cx = Math.floor(a[k] / tol);
      const cy = Math.floor(a[k + 1] / tol);
      const cz = Math.floor(a[k + 2] / tol);
      let achou = false;
      for (let dx = -1; dx <= 1 && !achou; dx++)
        for (let dy = -1; dy <= 1 && !achou; dy++)
          for (let dz = -1; dz <= 1 && !achou; dz++) {
            const v = H.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!v) continue;
            for (let j = 0; j < v.length; j += 3)
              if (Math.hypot(a[k] - v[j], a[k + 1] - v[j + 1], a[k + 2] - v[j + 2]) < tol) {
                achou = true;
                break;
              }
          }
      if (achou) n++;
    }
    return n;
  };
}

// ---- leitura -------------------------------------------------------------------------
const occt = await require('occt-import-js')();
console.log(`Lendo ${entrada} ...`);
const r = occt.ReadStepFile(new Uint8Array(readFileSync(entrada)), {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.25,
  angularDeflection: 0.4,
});
if (!r.success) throw new Error('Falha ao ler o STEP');
const malhas = r.meshes.map((m, i) => ({
  i,
  nome: m.name,
  cor: m.color ?? null,
  pos: m.attributes.position.array,
  nor: m.attributes.normal?.array ?? null,
  idx: m.index.array,
  cx: caixa(m.attributes.position.array),
}));
console.log(`${malhas.length} malhas, ${malhas.reduce((s, m) => s + m.idx.length / 3, 0)} triângulos`);

// ---- 1. conjuntos motor+redutor e flanges -------------------------------------------
const nos = [];
(function percorrer(n) {
  if ((n.meshes?.length ?? 0) >= 8) nos.push(n.meshes);
  for (const c of n.children ?? []) percorrer(c);
})(r.root);
const pareceFlange = (m) => {
  const d = [...m.cx.dim].sort((a, b) => a - b);
  // 45 × 45 × 11 mm; a tampa traseira do Nema 17 (42 × 42 × 9) não pode passar
  return d[0] > 9.5 && d[0] < 12.5 && d[1] > 43.5 && d[1] < 47 && d[2] > 43.5 && d[2] < 47;
};
const conjuntos = nos
  .map((ids) => {
    const flange = ids.map((i) => malhas[i]).find(pareceFlange);
    if (!flange) return null;
    const fino = flange.cx.dim.indexOf(Math.min(...flange.cx.dim));
    const eixo = [0, 0, 0];
    eixo[fino] = 1;
    return { ids, flange: flange.i, ponto: flange.cx.centro, eixo };
  })
  .filter(Boolean);
if (conjuntos.length !== 4) throw new Error(`Esperava 4 conjuntos motor+redutor, achei ${conjuntos.length}`);

const contagem = (e) => conjuntos.filter((c) => Math.abs(dot(c.eixo, e)) > 0.9).length;
const base = conjuntos.find((c) => contagem(c.eixo) === 1);
if (!base) throw new Error('Não achei o redutor da base (eixo perpendicular aos demais)');
const pitch = conjuntos.filter((c) => c !== base);

// ---- 2. ordem da cadeia: cada junta é a mais próxima da anterior -----------------------
const resto = [...pitch];
const ordem = [];
let ref = base;
while (resto.length) {
  resto.sort((a, b) => norma(sub(a.ponto, ref.ponto)) - norma(sub(b.ponto, ref.ponto)));
  ref = resto.shift();
  ordem.push(ref);
}
const [ombro, cotovelo, punho] = ordem;

// ---- 3 e 4. atribuição das peças --------------------------------------------------------
const grupoDe = new Map();
const cadeia = [base, ombro, cotovelo, punho];
cadeia.forEach((c, k) => {
  for (const i of c.ids) grupoDe.set(i, GRUPOS[k]);
  grupoDe.set(c.flange, GRUPOS[k + 1]);
});
let livres = malhas.filter((m) => !grupoDe.has(m.i));
while (livres.length) {
  const indices = Object.fromEntries(
    GRUPOS.map((g) => [g, indice(malhas.filter((m) => grupoDe.get(m.i) === g).map((m) => m.pos), 0.8)]),
  );
  let melhor = null;
  for (const m of livres)
    for (const g of GRUPOS) {
      const n = indices[g](m.pos);
      if (n > 0 && (!melhor || n > melhor.n)) melhor = { m, g, n };
    }
  if (!melhor) break;
  grupoDe.set(melhor.m.i, melhor.g);
  console.log(`  ${melhor.m.nome || '(sem nome)'} #${melhor.m.i} -> ${melhor.g} (${melhor.n} vértices em contato)`);
  livres = livres.filter((m) => m !== melhor.m);
}
for (const m of livres) {
  grupoDe.set(m.i, 'fixo');
  console.log(`  ${m.nome || '(sem nome)'} #${m.i} -> fixo (sem contato)`);
}

// ---- 5. referencial do robô e geometria ---------------------------------------------------
// z = eixo da base, no sentido do motor para o flange (o lado da torre)
const carcacaBase = caixa(base.ids.filter((i) => i !== base.flange).flatMap((i) => Array.from(malhas[i].pos)));
let z = base.eixo;
if (dot(sub(base.ponto, carcacaBase.centro), z) < 0) z = escala(z, -1);
// y ao longo dos eixos de pitch, com sinal tal que x aponte da base para o cotovelo
let y = ombro.eixo;
let x = cross(y, z);
const radial = (p) => {
  const v = sub(p, base.ponto);
  return dot(v, x);
};
if (radial(cotovelo.ponto) < radial(ombro.ponto)) {
  y = escala(y, -1);
  x = cross(y, z);
}
x = unit(x);
y = unit(y);
z = unit(z);
if (process.env.DEPURAR) console.log({ x, y, z, base: base.ponto, carcaca: carcacaBase.centro, ombro: ombro.ponto, cotovelo: cotovelo.ponto, punho: punho.ponto });
const plano = (p) => {
  const v = sub(p, base.ponto);
  return [dot(v, x), dot(v, z)];
};
const [rS, zS] = plano(ombro.ponto);
const [rE, zE] = plano(cotovelo.ponto);
const [rW, zW] = plano(punho.ponto);
// Mesa = face de baixo da peça fixa com maior área de apoio (a placa de montagem).
// O motor da base pode ficar pendurado abaixo dela (passa por um furo na mesa).
const apoios = [];
for (const m of malhas) {
  if (grupoDe.get(m.i) !== 'fixo' || base.ids.includes(m.i)) continue;
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < m.pos.length; k += 3) {
    const v = sub([m.pos[k], m.pos[k + 1], m.pos[k + 2]], base.ponto);
    const c = [dot(v, x), dot(v, y), dot(v, z)];
    mn = mn.map((a, d) => Math.min(a, c[d]));
    mx = mx.map((a, d) => Math.max(a, c[d]));
  }
  apoios.push({ area: (mx[0] - mn[0]) * (mx[1] - mn[1]), fundo: mn[2] });
}
// entre as peças com área parecida com a maior, a de fundo mais baixo
const maiorArea = Math.max(...apoios.map((a) => a.area));
const chao = Math.min(...apoios.filter((a) => a.area >= 0.8 * maiorArea).map((a) => a.fundo));
const geometria = {
  alturaOmbro: +(zS - chao).toFixed(2),
  offsetOmbro: +rS.toFixed(2),
  L1: +Math.hypot(rE - rS, zE - zS).toFixed(2),
  L2: +Math.hypot(rW - rE, zW - zE).toFixed(2),
};
const t1 = Math.atan2(zE - zS, rE - rS);
const t2 = Math.atan2(zW - zE, rW - rE) - t1;
console.log('Geometria do CAD:', geometria);
console.log(`Pose do CAD: ombro ${(t1 * GRAUS).toFixed(2)}°, cotovelo ${(t2 * GRAUS).toFixed(2)}°, punho 0° (adotado)`);

// CAD -> mundo do robô (q = 0 na base) -> local de cada junta (pose zero)
const h = geometria.alturaOmbro;
const paraRobo = (p) => {
  const v = sub(p, base.ponto);
  return [dot(v, x), dot(v, y), dot(v, z) - zS + h];
};
// Ry(+t) do three.js, que desfaz o rotation.y = -t usado nas juntas de pitch
const rotY = (p, t) => [p[0] * Math.cos(t) + p[2] * Math.sin(t), p[1], -p[0] * Math.sin(t) + p[2] * Math.cos(t)];
const paraLocal = {
  fixo: (p) => p,
  torre: (p) => p,
  ombro: (p) => rotY(sub(p, [rS, 0, h]), t1),
  cotovelo: (p) => rotY(sub(rotY(sub(p, [rS, 0, h]), t1), [geometria.L1, 0, 0]), t2),
  punho: (p) => sub(rotY(sub(rotY(sub(p, [rS, 0, h]), t1), [geometria.L1, 0, 0]), t2), [geometria.L2, 0, 0]),
};
const rotacaoLocal = { fixo: 0, torre: 0, ombro: t1, cotovelo: t1 + t2, punho: t1 + t2 };
const juntaDoFlange = { [base.flange]: 0, [ombro.flange]: 1, [cotovelo.flange]: 2, [punho.flange]: 3 };

// ---- primitivas por grupo e material ---------------------------------------------------------
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const COR_SEM = [0.17, 0.18, 0.2]; // peças sem cor no STEP (motores): grafite
const COR_SAIDA = [0.94, 0.54, 0.14]; // flanges de saída destacados
const prims = new Map();
for (const m of malhas) {
  const g = grupoDe.get(m.i);
  const saida = juntaDoFlange[m.i];
  const corS = saida !== undefined ? COR_SAIDA : (m.cor ?? COR_SEM);
  const nomeMat = saida !== undefined ? `saida-${saida}` : `cor-${corS.map((c) => c.toFixed(2)).join('-')}`;
  const chave = `${g}|${nomeMat}`;
  if (!prims.has(chave))
    prims.set(chave, { grupo: g, nomeMat, cor: corS.map(linear), metal: m.nome?.startsWith('Rolamento') ? 0.8 : 0.1, pos: [], nor: [], idx: [] });
  const P = prims.get(chave);
  const base0 = P.pos.length / 3;
  const L = paraLocal[g];
  const rot = rotacaoLocal[g];
  for (let k = 0; k < m.pos.length; k += 3) {
    P.pos.push(...L(paraRobo([m.pos[k], m.pos[k + 1], m.pos[k + 2]])));
    if (m.nor) {
      const nCad = [m.nor[k], m.nor[k + 1], m.nor[k + 2]];
      P.nor.push(...rotY([dot(nCad, x), dot(nCad, y), dot(nCad, z)], rot));
    }
  }
  for (const ix of m.idx) P.idx.push(ix + base0);
}

// ---- GLB ---------------------------------------------------------------------------------
const pedacos = [];
let deslocamento = 0;
const gltf = {
  asset: { version: '2.0', generator: 'importar-step.mjs (braço RRRR)' },
  scene: 0,
  scenes: [{ nodes: [], extras: { geometria, poseCAD: { ombro: t1 * GRAUS, cotovelo: t2 * GRAUS }, origem: entrada.split(/[\\/]/).pop() } }],
  nodes: [],
  meshes: [],
  materials: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
};
function adicionarVista(tipado, alvo) {
  const bytes = new Uint8Array(tipado.buffer, tipado.byteOffset, tipado.byteLength);
  pedacos.push(bytes);
  const pad = (4 - (bytes.length % 4)) % 4;
  if (pad) pedacos.push(new Uint8Array(pad));
  gltf.bufferViews.push({ buffer: 0, byteOffset: deslocamento, byteLength: bytes.length, target: alvo });
  deslocamento += bytes.length + pad;
  return gltf.bufferViews.length - 1;
}
const materiais = new Map();
for (const g of GRUPOS) {
  const primitivas = [];
  for (const P of prims.values()) {
    if (P.grupo !== g || !P.idx.length) continue;
    if (!materiais.has(P.nomeMat)) {
      gltf.materials.push({
        name: P.nomeMat,
        pbrMetallicRoughness: { baseColorFactor: [...P.cor, 1], metallicFactor: P.metal, roughnessFactor: 0.6 },
      });
      materiais.set(P.nomeMat, gltf.materials.length - 1);
    }
    const pos = new Float32Array(P.pos);
    const cx = caixa(pos);
    const vPos = adicionarVista(pos, 34962);
    gltf.accessors.push({ bufferView: vPos, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: cx.mn, max: cx.mx });
    const atributos = { POSITION: gltf.accessors.length - 1 };
    if (P.nor.length === P.pos.length) {
      const vNor = adicionarVista(new Float32Array(P.nor), 34962);
      gltf.accessors.push({ bufferView: vNor, componentType: 5126, count: P.nor.length / 3, type: 'VEC3' });
      atributos.NORMAL = gltf.accessors.length - 1;
    }
    const vIdx = adicionarVista(new Uint32Array(P.idx), 34963);
    gltf.accessors.push({ bufferView: vIdx, componentType: 5125, count: P.idx.length, type: 'SCALAR' });
    primitivas.push({ attributes: atributos, indices: gltf.accessors.length - 1, material: materiais.get(P.nomeMat) });
  }
  gltf.meshes.push({ name: g, primitives: primitivas });
  gltf.nodes.push({ name: g, mesh: gltf.meshes.length - 1 });
  gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
}
gltf.buffers.push({ byteLength: deslocamento });

const json = Buffer.from(JSON.stringify(gltf));
const jsonPad = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const bin = Buffer.concat(pedacos.map((p) => Buffer.from(p)));
const total = 12 + 8 + jsonPad.length + 8 + bin.length;
const cab = Buffer.alloc(12);
cab.writeUInt32LE(0x46546c67, 0);
cab.writeUInt32LE(2, 4);
cab.writeUInt32LE(total, 8);
const cj = Buffer.alloc(8);
cj.writeUInt32LE(jsonPad.length, 0);
cj.writeUInt32LE(0x4e4f534a, 4);
const cb = Buffer.alloc(8);
cb.writeUInt32LE(bin.length, 0);
cb.writeUInt32LE(0x004e4942, 4);
mkdirSync(dirname(saida), { recursive: true });
writeFileSync(saida, Buffer.concat([cab, cj, jsonPad, cb, bin]));
console.log(`Gravado ${saida} (${(total / 1e6).toFixed(1)} MB)`);
for (const g of GRUPOS) {
  const n = malhas.filter((m) => grupoDe.get(m.i) === g).length;
  console.log(`  ${g}: ${n} peças`);
}
