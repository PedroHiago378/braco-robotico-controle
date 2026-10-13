// Transporte Web Serial (Chrome/Edge). A página precisa estar em localhost ou https.

export class TransporteSerial {
  static suportado() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  constructor(baud = 115200) {
    this.baud = baud;
    this.aoReceber = null;
    this.aoFechar = null;
    this.nome = 'Serial USB';
    this._fechando = false;
  }

  async abrir() {
    this.porta = await navigator.serial.requestPort();
    await this.porta.open({ baudRate: this.baud, bufferSize: 8192 });
    const { usbVendorId: v, usbProductId: p } = this.porta.getInfo();
    if (v !== undefined) this.nome = `Serial USB ${v.toString(16).padStart(4, '0')}:${p.toString(16).padStart(4, '0')}`;
    this.escritor = this.porta.writable.getWriter();
    this._aoDesconectar = (e) => {
      if (e.target === this.porta) this._encerrar('dispositivo removido');
    };
    navigator.serial.addEventListener('disconnect', this._aoDesconectar);
    this._ler();
  }

  async _ler() {
    const dec = new TextDecoder();
    let buf = '';
    while (this.porta?.readable && !this._fechando) {
      this.leitor = this.porta.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.leitor.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            this.aoReceber?.(l);
          }
          if (buf.length > 4096) buf = ''; // lixo sem fim de linha (baud errado?)
        }
      } catch (e) {
        if (!this._fechando) console.warn('erro de leitura serial', e); // erro não fatal: tenta de novo
      } finally {
        this.leitor.releaseLock();
      }
    }
    this._encerrar('porta fechada');
  }

  _encerrar(motivo) {
    if (this._fechando) return;
    this._fechando = true;
    this.aoFechar?.(motivo);
    this.fechar();
  }

  async escrever(texto) {
    if (!this.escritor) throw new Error('porta fechada');
    await this.escritor.write(new TextEncoder().encode(texto));
  }

  async fechar() {
    this._fechando = true;
    navigator.serial?.removeEventListener('disconnect', this._aoDesconectar);
    try {
      await this.leitor?.cancel();
    } catch {
      /* já cancelado */
    }
    try {
      this.escritor?.releaseLock();
    } catch {
      /* já liberado */
    }
    this.escritor = null;
    try {
      await this.porta?.close();
    } catch {
      /* já fechada */
    }
    this.porta = null;
  }
}
