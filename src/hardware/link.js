// Camada de protocolo sobre um transporte (serial real ou simulador).
// Controle de fluxo por contagem de caracteres: nunca há mais bytes em trânsito do que
// cabem no buffer de recepção do firmware.

import { Emissor } from '../nucleo/util.js';
import { ERROS, ALARMES, parseHello, parseStatus } from './protocolo.js';

export class ErroFirmware extends Error {
  constructor(codigo, texto) {
    super(`Firmware: ${ERROS[codigo] ?? texto ?? 'erro ' + codigo}`);
    this.codigo = codigo;
  }
}

export class LinkRobo extends Emissor {
  constructor() {
    super();
    this.transporte = null;
    this.estado = 'desconectado'; // desconectado | conectando | pronto
    this.info = null;
    this.status = null;
    this.fila = [];
    this.emVoo = [];
    this.bytesEmVoo = 0;
    this._esperaStatus = [];
  }

  get pronto() {
    return this.estado === 'pronto';
  }

  /** Soma da duração (ms) dos segmentos enviados que o firmware ainda não confirmou. */
  get msEmVoo() {
    let ms = 0;
    for (const c of this.emVoo) ms += c.meta.segMs ?? 0;
    for (const c of this.fila) ms += c.meta.segMs ?? 0;
    return ms;
  }

  _mudarEstado(e) {
    this.estado = e;
    this.emit('estado', e);
  }

  async conectar(transporte, { timeoutMs = 6000 } = {}) {
    if (this.transporte) await this.desconectar();
    this.transporte = transporte;
    transporte.aoReceber = (l) => this._aoLinha(l);
    transporte.aoFechar = (motivo) => this._aoFechar(motivo);
    this._mudarEstado('conectando');
    let enviouV = false;
    try {
      await transporte.abrir();
      this.info = await new Promise((resolve, reject) => {
        this._esperaHello = resolve;
        // O Uno reinicia ao abrir a porta e se apresenta sozinho; se nada chegar, pedimos.
        const t1 = setTimeout(() => {
          enviouV = true;
          transporte.escrever('\nV\n').catch(() => {});
        }, 2000);
        const t2 = setTimeout(() => reject(new Error('O firmware não respondeu (esperava "BRACO ...")')), timeoutMs);
        this._limparEsperaHello = () => {
          clearTimeout(t1);
          clearTimeout(t2);
        };
      });
      this._limparEsperaHello();
      this._esperaHello = null;
      // Descarta o eco do "V" (hello repetido e "ok") antes de aceitar comandos,
      // senão aquele "ok" seria casado com o primeiro comando enviado.
      if (enviouV) await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      this._limparEsperaHello?.();
      this._esperaHello = null;
      await this.desconectar();
      throw e;
    }
    this.fila = [];
    this.emVoo = [];
    this.bytesEmVoo = 0;
    this._mudarEstado('pronto');
    return this.info;
  }

  async desconectar() {
    const t = this.transporte;
    this.transporte = null;
    if (t) {
      t.aoFechar = null;
      try {
        await t.fechar();
      } catch {
        /* porta já fechada */
      }
    }
    this._aoFechar('desconectado');
  }

  _aoFechar(motivo) {
    const pendentes = [...this.emVoo, ...this.fila];
    this.emVoo = [];
    this.fila = [];
    this.bytesEmVoo = 0;
    for (const c of pendentes) c.reject(new Error('Conexão encerrada'));
    for (const w of this._esperaStatus) w.reject(new Error('Conexão encerrada'));
    this._esperaStatus = [];
    this.transporte = null;
    this.status = null;
    if (this.estado !== 'desconectado') {
      this._mudarEstado('desconectado');
      this.emit('mensagem', `Conexão encerrada: ${motivo}`);
    }
  }

  /** Envia um comando e resolve no "ok" (rejeita com ErroFirmware no "erro"). */
  comando(linha, meta = {}) {
    if (!this.pronto) return Promise.reject(new Error('Robô desconectado'));
    return new Promise((resolve, reject) => {
      this.fila.push({ texto: linha + '\n', resolve, reject, meta });
      this._bombear();
    });
  }

  _bombear() {
    const limite = (this.info?.rx ?? 64) - 1;
    while (this.fila.length && this.transporte) {
      const c = this.fila[0];
      if (this.emVoo.length && this.bytesEmVoo + c.texto.length > limite) break;
      this.fila.shift();
      this.emVoo.push(c);
      this.bytesEmVoo += c.texto.length;
      this.emit('enviado', c.texto.trimEnd());
      this.transporte.escrever(c.texto).catch((e) => this._aoFechar(e.message));
    }
  }

  tempoReal(ch) {
    if (!this.transporte) return;
    this.transporte.escrever(ch).catch((e) => this._aoFechar(e.message));
  }

  pedirStatus() {
    this.tempoReal('?');
  }

  /** Pede status e espera a resposta. */
  statusAgora(timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this._esperaStatus.push(w);
      setTimeout(() => {
        const i = this._esperaStatus.indexOf(w);
        if (i >= 0) {
          this._esperaStatus.splice(i, 1);
          reject(new Error('Sem resposta de status'));
        }
      }, timeoutMs);
      this.pedirStatus();
    });
  }

  /** Parada de emergência: descarta o que não foi enviado e manda "!" ao firmware. */
  emergencia() {
    this.tempoReal('!');
    const descartados = this.fila;
    this.fila = [];
    for (const c of descartados) c.reject(new Error('Cancelado pela parada de emergência'));
  }

  _aoLinha(linha) {
    const l = linha.trim();
    if (!l) return;
    if (l.startsWith('<')) {
      const s = parseStatus(l);
      if (s) {
        this.status = s;
        this.emit('status', s);
        const ws = this._esperaStatus;
        this._esperaStatus = [];
        for (const w of ws) w.resolve(s);
      }
      return;
    }
    this.emit('linha', l);
    if (l === 'ok' || l.startsWith('erro')) {
      const c = this.emVoo.shift();
      if (!c) return; // resposta a um "V" avulso
      this.bytesEmVoo -= c.texto.length;
      if (l === 'ok') c.resolve();
      else {
        const m = /^erro\s+(\d+)\s*(.*)$/.exec(l);
        c.reject(new ErroFirmware(m ? Number(m[1]) : 0, m?.[2]));
      }
      this._bombear();
      return;
    }
    if (l.startsWith('BRACO')) {
      const info = parseHello(l);
      if (info && this._esperaHello) this._esperaHello(info);
      else if (info && this.pronto) {
        this.info = info;
        this.emit('reinicio', info); // firmware reiniciou com a conexão aberta
      }
      return;
    }
    if (l.startsWith('ALARME')) {
      const m = /^ALARME\s+(\d+)\s*(.*)$/.exec(l);
      const cod = m ? Number(m[1]) : 0;
      this.emit('alarme', { codigo: cod, texto: ALARMES[cod] ?? m?.[2] ?? l });
      return;
    }
    if (l.startsWith('MSG')) this.emit('mensagem', l.slice(3).trim());
  }
}
