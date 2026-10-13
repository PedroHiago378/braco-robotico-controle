// Relógio de controle. Usa um Web Worker porque timers de aba em segundo plano são
// limitados a 1 Hz pelo navegador, o que esvaziaria a fila do firmware.

export function criarRelogio(fn, periodoMs = 5) {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
    try {
      const codigo = 'let id=null;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};';
      const url = URL.createObjectURL(new Blob([codigo], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = () => fn();
      w.postMessage(periodoMs);
      return () => {
        w.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      /* cai no setInterval */
    }
  }
  const id = setInterval(fn, periodoMs);
  return () => clearInterval(id);
}
