// Cena 3D: braço real (opaco), braço alvo (fantasma), gizmo para arrastar o alvo,
// trilha da ponta, caminho da timeline com keyframes clicáveis e região alcançável.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Emissor, RAD } from '../nucleo/util.js';
import { ModeloBraco } from './modelo-braco.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const TAM_TRILHA = 1000;

const VISTAS = {
  iso: { pos: [640, -780, 520], alvo: [140, 0, 170] },
  topo: { pos: [120, -1, 1700], alvo: [120, 0, 0] },
  frente: { pos: [120, -1500, 220], alvo: [120, 0, 220] },
  lado: { pos: [1500, 0, 220], alvo: [120, 0, 220] },
};

export class Visualizador3D extends Emissor {
  constructor(container, geometria) {
    super();
    this.container = container;
    this.arrastando = false;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(r.domElement);

    this.cena = new THREE.Scene();
    this.cena.background = new THREE.Color(0x12151a);

    this.camera = new THREE.PerspectiveCamera(40, 1, 2, 20000);
    this.orbita = new OrbitControls(this.camera, r.domElement);
    this.orbita.enableDamping = true;
    this.orbita.dampingFactor = 0.12;
    this.vista('iso');

    this.cena.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2420, 1.15));
    const sol = new THREE.DirectionalLight(0xffffff, 1.9);
    sol.position.set(500, -700, 1400);
    sol.castShadow = true;
    sol.shadow.mapSize.set(2048, 2048);
    Object.assign(sol.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 100, far: 4000 });
    sol.shadow.bias = -0.0005;
    this.cena.add(sol);

    const piso = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.35 }));
    piso.receiveShadow = true;
    this.cena.add(piso);
    const grade = new THREE.GridHelper(2000, 40, 0x3b4452, 0x232932);
    grade.rotation.x = Math.PI / 2;
    grade.position.z = 0.2;
    this.cena.add(grade);
    const eixos = new THREE.AxesHelper(140);
    eixos.position.z = 0.5;
    this.cena.add(eixos);

    this.real = new ModeloBraco(geometria);
    this.alvo = new ModeloBraco(geometria, { fantasma: true });
    this.cena.add(this.real.raiz, this.alvo.raiz);

    // marcador do alvo + gizmo de translação
    this.marcador = new THREE.Mesh(
      new THREE.SphereGeometry(12, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.marcador.renderOrder = 10;
    this.cena.add(this.marcador);
    this.gizmo = new TransformControls(this.camera, r.domElement);
    this.gizmo.setMode('translate');
    this.gizmo.setSize(0.8);
    this.gizmo.attach(this.marcador);
    this.cena.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbita.enabled = !e.value;
      this.arrastando = e.value;
      this.emit(e.value ? 'arrasteInicio' : 'arrasteFim');
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.arrastando) this.emit('arrasteAlvo', this.marcador.position.clone());
    });

    // trilha da ponta real
    this._trilha = new Float32Array(TAM_TRILHA * 3);
    this._nTrilha = 0;
    const gT = new THREE.BufferGeometry();
    gT.setAttribute('position', new THREE.BufferAttribute(this._trilha, 3));
    gT.setDrawRange(0, 0);
    this.trilha = new THREE.Line(gT, new THREE.LineBasicMaterial({ color: 0xffb74d }));
    this.trilha.frustumCulled = false;
    this.cena.add(this.trilha);

    // caminho da timeline
    this.caminho = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xb388ff, transparent: true, opacity: 0.85 }),
    );
    this.caminho.frustumCulled = false;
    this.marcasKF = new THREE.Group();
    this.cena.add(this.caminho, this.marcasKF);
    this._geoKF = new THREE.SphereGeometry(7, 16, 12);
    this._matKF = new THREE.MeshBasicMaterial({ color: 0xb388ff });
    this._matKFSel = new THREE.MeshBasicMaterial({ color: 0xffd54f });

    // região alcançável (fatia no plano do braço alvo)
    this.alcance = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0x66bb6a, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.alcance.frustumCulled = false;
    this.grupoAlcance = new THREE.Group();
    this.grupoAlcance.add(this.alcance);
    this.grupoAlcance.visible = false;
    this.cena.add(this.grupoAlcance);

    // clique em keyframe
    this.raycaster = new THREE.Raycaster();
    let inicio = null;
    r.domElement.addEventListener('pointerdown', (e) => (inicio = [e.clientX, e.clientY]));
    r.domElement.addEventListener('pointerup', (e) => {
      if (!inicio || this.arrastando) return;
      if (Math.hypot(e.clientX - inicio[0], e.clientY - inicio[1]) > 4) return;
      this._clique(e);
    });

    new ResizeObserver(() => this._redimensionar()).observe(container);
    this._redimensionar();
    r.setAnimationLoop(() => {
      this.orbita.update();
      r.render(this.cena, this.camera);
    });
  }

  _redimensionar() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _clique(e) {
    const ret = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - ret.left) / ret.width) * 2 - 1, -((e.clientY - ret.top) / ret.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.marcasKF.children, false)[0];
    if (hit) this.emit('cliqueKF', hit.object.userData.id);
  }

  vista(nome) {
    const v = VISTAS[nome] ?? VISTAS.iso;
    this.camera.position.set(...v.pos);
    this.orbita.target.set(...v.alvo);
    this.orbita.update();
  }

  reconstruir(geometria) {
    this.real.construir(geometria);
    this.alvo.construir(geometria);
  }

  /** Carrega o GLB gerado do STEP (npm run importar-step). Resolve com a geometria do CAD. */
  async carregarCAD(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const geometria = gltf.scene.userData?.geometria;
    if (!geometria) throw new Error('GLB sem a geometria do CAD (gere com npm run importar-step)');
    this.real.definirCAD(gltf.scene, geometria);
    this.alvo.definirCAD(gltf.scene, geometria);
    return { geometria, origem: gltf.scene.userData.origem };
  }

  usarCAD(v) {
    this.real.usarCAD(v);
    this.alvo.usarCAD(v);
  }

  definirPoses(qReal, qAlvo) {
    this.real.definir(qReal);
    this.alvo.definir(qAlvo);
  }

  definirMarcador(p, valido) {
    if (!this.arrastando) this.marcador.position.set(p[0], p[1], p[2]);
    this.marcador.material.color.setHex(valido ? 0x4fc3f7 : 0xff5252);
  }

  gizmoAtivo(v) {
    this.gizmo.enabled = v;
    this.gizmo.getHelper().visible = v;
    this.marcador.visible = v;
  }

  adicionarTrilha(p) {
    const n = this._nTrilha;
    const a = this._trilha;
    if (n > 0) {
      const k = (n - 1) * 3;
      if (Math.hypot(a[k] - p[0], a[k + 1] - p[1], a[k + 2] - p[2]) < 1) return;
    }
    if (n >= TAM_TRILHA) {
      a.copyWithin(0, 3);
      a.set(p, (TAM_TRILHA - 1) * 3);
    } else {
      a.set(p, n * 3);
      this._nTrilha++;
    }
    this.trilha.geometry.attributes.position.needsUpdate = true;
    this.trilha.geometry.setDrawRange(0, this._nTrilha);
  }

  limparTrilha() {
    this._nTrilha = 0;
    this.trilha.geometry.setDrawRange(0, 0);
  }

  /** pontas: [[x,y,z]...] ao longo da timeline; kfs: [{id, p}] */
  definirCaminho(pontas, kfs, selecionado) {
    const g = this.caminho.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pontas.flat(), 3));
    g.computeBoundingSphere();
    this.marcasKF.clear();
    for (const k of kfs) {
      const sel = k.id === selecionado;
      const m = new THREE.Mesh(this._geoKF, sel ? this._matKFSel : this._matKF);
      m.position.set(...k.p);
      m.scale.setScalar(sel ? 1.5 : 1);
      m.userData.id = k.id;
      this.marcasKF.add(m);
    }
  }

  mostrarCaminho(v) {
    this.caminho.visible = v;
    this.marcasKF.visible = v;
  }

  /** pts: [r0, z0, r1, z1, ...] no plano do braço. */
  definirAlcance(pts) {
    const pos = new Float32Array((pts.length / 2) * 3);
    for (let i = 0, k = 0; i < pts.length; i += 2, k += 3) {
      pos[k] = pts[i];
      pos[k + 2] = pts[i + 1];
    }
    this.alcance.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  }

  orientarAlcance(q1) {
    this.grupoAlcance.rotation.z = q1 * RAD;
  }
}
