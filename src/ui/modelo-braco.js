// Modelo 3D do braço, montado em hierarquia: base -> torre (q1) -> ombro (t1) -> cotovelo (t2) -> punho (t3).
// Cada grupo de pitch gira em torno de y; elos ao longo de +x. Unidades: mm. Mundo com z para cima.
// Desenha as peças do CAD (GLB gerado do STEP) quando carregado; senão, um modelo simplificado.

import * as THREE from 'three';
import { RAD } from '../nucleo/util.js';

const CORES = {
  base: 0x353a44,
  elo: 0xd9dde4,
  motor: 0x23272e,
  redutor: 0xf08a24,
  ferramenta: 0xb8c0cc,
  ponta: 0xff5c5c,
};

const GRUPOS_CAD = ['fixo', 'torre', 'ombro', 'cotovelo', 'punho'];

export class ModeloBraco {
  /** fantasma: desenho translúcido para o alvo. */
  constructor(geometria, { fantasma = false, cor = 0x4fc3f7 } = {}) {
    this.fantasma = fantasma;
    this.corFantasma = cor;
    this.raiz = new THREE.Group();
    this._cad = null;
    this._usarCAD = true;
    this.construir(geometria);
  }

  _mat(cor) {
    const m = this.fantasma
      ? new THREE.MeshBasicMaterial({ color: this.corFantasma, transparent: true, opacity: 0.16, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: cor, metalness: 0.25, roughness: 0.6 });
    this._materiais.push(m);
    return m;
  }

  _add(pai, geo, mat, x = 0, y = 0, z = 0) {
    this._geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = !this.fantasma;
    mesh.receiveShadow = !this.fantasma;
    pai.add(mesh);
    return mesh;
  }

  /** Cilindro com eixo ao longo de 'x', 'y' ou 'z'. */
  _cil(r, comp, eixo) {
    const g = new THREE.CylinderGeometry(r, r, comp, 32);
    if (eixo === 'x') g.rotateZ(-Math.PI / 2);
    if (eixo === 'z') g.rotateX(Math.PI / 2);
    return g;
  }

  construir(g) {
    this.g = { ...g };
    for (const geo of this._geos ?? []) geo.dispose();
    for (const m of this._materiais ?? []) m.dispose();
    this.raiz.clear();
    this._geos = [];
    this._materiais = [];
    const hBase = Math.max(20, Math.min(60, g.alturaOmbro * 0.4));
    const a = g.offsetOmbro;

    this.torre = new THREE.Group();
    this.ombro = new THREE.Group();
    this.ombro.position.set(a, 0, g.alturaOmbro);
    this.cotovelo = new THREE.Group();
    this.cotovelo.position.set(g.L1, 0, 0);
    this.punho = new THREE.Group();
    this.punho.position.set(g.L2, 0, 0);
    this.raiz.add(this.torre);
    this.torre.add(this.ombro);
    this.ombro.add(this.cotovelo);
    this.cotovelo.add(this.punho);

    // modelo simplificado (cada parte num subgrupo, para trocar pelo CAD)
    const pais = { fixo: this.raiz, torre: this.torre, ombro: this.ombro, cotovelo: this.cotovelo, punho: this.punho };
    this.prim = {};
    for (const [k, pai] of Object.entries(pais)) {
      this.prim[k] = new THREE.Group();
      pai.add(this.prim[k]);
    }
    const P = this.prim;
    this._add(P.fixo, this._cil(75, hBase, 'z'), this._mat(CORES.base), 0, 0, hBase / 2);
    const matTorre = this._mat(CORES.redutor);
    this._add(P.torre, this._cil(62, 14, 'z'), matTorre, 0, 0, hBase + 7);
    const hCol = g.alturaOmbro - hBase - 14;
    if (hCol > 4) {
      const matCol = this._mat(CORES.base);
      for (const s of [-1, 1]) this._add(P.torre, new THREE.BoxGeometry(70, 10, hCol), matCol, a, s * 48, hBase + 14 + hCol / 2);
    }
    const matOmbro = this._mat(CORES.redutor);
    this._add(P.ombro, this._cil(34, 22, 'y'), matOmbro, 0, -24, 0);
    this._add(P.ombro, this._cil(22, 50, 'y'), this._mat(CORES.motor), 0, -58, 0);
    this._add(P.ombro, new THREE.BoxGeometry(g.L1, 30, 26), this._mat(CORES.elo), g.L1 / 2, 0, 0);
    const matCot = this._mat(CORES.redutor);
    this._add(P.cotovelo, this._cil(30, 20, 'y'), matCot, 0, 24, 0);
    this._add(P.cotovelo, this._cil(21, 46, 'y'), this._mat(CORES.motor), 0, 56, 0);
    this._add(P.cotovelo, new THREE.BoxGeometry(g.L2, 24, 20), this._mat(CORES.elo), g.L2 / 2, 0, 0);
    const matPunho = this._mat(CORES.redutor);
    this._add(P.punho, this._cil(26, 18, 'y'), matPunho, 0, -21, 0);
    this._add(P.punho, this._cil(20, 42, 'y'), this._mat(CORES.motor), 0, -50, 0);
    this.matsJunta = [matTorre, matOmbro, matCot, matPunho];

    // ferramenta: não existe no CAD, então aparece nos dois modos
    if (g.L3 > 1) this._add(this.punho, this._cil(7, g.L3, 'x'), this._mat(CORES.ferramenta), g.L3 / 2, 0, 0);
    this._add(this.punho, new THREE.SphereGeometry(9, 20, 14), this._mat(CORES.ponta), g.L3, 0, 0);

    this._anexarCAD();
    if (this._q) this.definir(this._q);
  }

  /** cena: raiz do GLB com nós fixo/torre/ombro/cotovelo/punho; geometria: a do CAD. */
  definirCAD(cena, geometria) {
    this._cad = { cena, geometria };
    this.construir(this.g);
  }

  _anexarCAD() {
    this.cadNos = [];
    this.matsSaida = [[], [], [], []];
    const c = this._cad;
    if (!c) return this.usarCAD(this._usarCAD);
    const pais = { fixo: this.raiz, torre: this.torre, ombro: this.ombro, cotovelo: this.cotovelo, punho: this.punho };
    // fixo e torre foram exportados com a altura do ombro do CAD; acompanham a da configuração
    const dz = this.g.alturaOmbro - c.geometria.alturaOmbro;
    const matFantasma = this.fantasma ? this._mat(0) : null;
    for (const nome of GRUPOS_CAD) {
      const no = c.cena.getObjectByName(nome);
      if (!no) continue;
      const copia = no.clone(true); // compartilha as geometrias do GLB
      if (nome === 'fixo' || nome === 'torre') copia.position.z += dz;
      copia.traverse((o) => {
        if (!o.isMesh) return;
        if (this.fantasma) {
          o.material = matFantasma;
          return;
        }
        o.material = o.material.clone();
        this._materiais.push(o.material);
        o.castShadow = true;
        o.receiveShadow = true;
        const m = /^saida-(\d)/.exec(o.material.name);
        if (m) this.matsSaida[Number(m[1])].push(o.material);
      });
      pais[nome].add(copia);
      this.cadNos.push(copia);
    }
    this.usarCAD(this._usarCAD);
  }

  get temCAD() {
    return !!this._cad;
  }

  usarCAD(v) {
    this._usarCAD = v;
    const cad = v && !!this._cad;
    for (const p of Object.values(this.prim)) p.visible = !cad;
    for (const n of this.cadNos ?? []) n.visible = cad;
  }

  definir(q) {
    this._q = [...q];
    this.torre.rotation.z = q[0] * RAD;
    this.ombro.rotation.y = -q[1] * RAD;
    this.cotovelo.rotation.y = -q[2] * RAD;
    this.punho.rotation.y = -q[3] * RAD;
  }

  /** Pinta de vermelho as juntas a menos de `margem` graus do limite. */
  destacarLimites(q, juntas, margem = 3) {
    if (this.fantasma) return;
    const cad = this._usarCAD && this._cad;
    juntas.forEach((j, i) => {
      const cor = Math.min(q[i] - j.min, j.max - q[i]) < margem ? 0xaa0000 : 0x000000;
      if (cad) for (const m of this.matsSaida[i]) m.emissive.setHex(cor);
      else this.matsJunta[i].emissive.setHex(cor);
    });
  }

  visivel(v) {
    this.raiz.visible = v;
  }
}
