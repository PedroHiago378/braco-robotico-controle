// Firmware do braço RRRR com 4 × Nema 17 (drivers STEP/DIR: A4988, DRV8825, TMC2209...).
//
// O planejamento de movimento fica no app. O firmware recebe segmentos curtos
// "vá às posições absolutas P (passos) em T microssegundos" e os executa com um
// gerador de passos por interrupção (DDA): todos os eixos chegam juntos, com passos
// distribuídos de forma uniforme. Protocolo completo em src/hardware/protocolo.js.
//
// Placas: Arduino Uno + CNC Shield V3, Mega 2560 + RAMPS 1.4, ESP32 (ver config.h).

#include <Arduino.h>
#include "config.h"

#if defined(ARDUINO_ARCH_ESP32)
#include "soc/gpio_reg.h"
#include "esp_rom_sys.h"
#define ISR_RAM IRAM_ATTR
#define ATRASO_US(x) esp_rom_delay_us(x)
#else
#define ISR_RAM
#define ATRASO_US(x) delayMicroseconds(x)
#endif

#define VERSAO "1.0"
#define TAM_LINHA 72

// Respostas de executar()
#define RESP_OK 0
#define RESP_ADIAR -1
#define RESP_NADA -2

// ---------------------------------------------------------------------------------------
// Fila de segmentos: o loop produz, a interrupção consome.

struct Segmento {
  int32_t alvo[N_EIXOS];
  uint32_t ticks;
};

static Segmento fila[TAM_FILA];
static volatile uint8_t filaCabeca = 0; // próximo a ser executado (ISR)
static volatile uint8_t filaCauda = 0;  // próximo a ser escrito (loop)

static volatile int32_t posicao[N_EIXOS];
static int32_t ultimoAlvo[N_EIXOS]; // alvo do último segmento enfileirado
static uint32_t velMax[N_EIXOS] = {4000, 4000, 4000, 4000}; // passos/s (comando M)

// Estado do segmento em execução (só a ISR escreve)
static volatile bool segAtivo = false;
static volatile uint32_t segTicks = 0;
static volatile uint32_t segTick = 0;
static uint32_t segDelta[N_EIXOS];
static uint32_t segAcc[N_EIXOS];
static int8_t segDir[N_EIXOS];
static int8_t dirAtual[N_EIXOS] = {0, 0, 0, 0};

// ---------------------------------------------------------------------------------------
// E/S rápida dentro da interrupção

#if defined(__AVR__)
static volatile uint8_t *regStep[N_EIXOS];
static volatile uint8_t *regDir[N_EIXOS];
static uint8_t mskStep[N_EIXOS];
static uint8_t mskDir[N_EIXOS];
static inline void stepAlto(uint8_t i) { *regStep[i] |= mskStep[i]; }
static inline void stepBaixo(uint8_t i) { *regStep[i] &= ~mskStep[i]; }
static inline void escreverDir(uint8_t i, bool alto) {
  if (alto) *regDir[i] |= mskDir[i];
  else *regDir[i] &= ~mskDir[i];
}
#else
static uint32_t mskStep[N_EIXOS];
static uint32_t mskDir[N_EIXOS];
static inline void ISR_RAM stepAlto(uint8_t i) { REG_WRITE(GPIO_OUT_W1TS_REG, mskStep[i]); }
static inline void ISR_RAM stepBaixo(uint8_t i) { REG_WRITE(GPIO_OUT_W1TC_REG, mskStep[i]); }
static inline void ISR_RAM escreverDir(uint8_t i, bool alto) {
  REG_WRITE(alto ? GPIO_OUT_W1TS_REG : GPIO_OUT_W1TC_REG, mskDir[i]);
}
#endif

// ---------------------------------------------------------------------------------------
// Gerador de passos (chamado a TICK_HZ)

static void ISR_RAM tickPasso() {
  if (!segAtivo) {
    if (filaCabeca == filaCauda) return;
    const Segmento &s = fila[filaCabeca];
    segTicks = s.ticks;
    segTick = 0;
    bool mudouDir = false;
    for (uint8_t i = 0; i < N_EIXOS; i++) {
      int32_t d = s.alvo[i] - posicao[i];
      int8_t dir = d >= 0 ? 1 : -1;
      segDelta[i] = d >= 0 ? (uint32_t)d : (uint32_t)(-d);
      segAcc[i] = s.ticks >> 1; // passos centrados no intervalo
      segDir[i] = dir;
      if (segDelta[i] && dir != dirAtual[i]) {
        escreverDir(i, dir > 0);
        dirAtual[i] = dir;
        mudouDir = true;
      }
    }
    filaCabeca = (uint8_t)((filaCabeca + 1) % TAM_FILA);
    segAtivo = true;
    if (mudouDir) ATRASO_US(1); // tempo de preparo do DIR antes do STEP
  }
  uint8_t passos = 0;
  const uint32_t T = segTicks;
  for (uint8_t i = 0; i < N_EIXOS; i++) {
    segAcc[i] += segDelta[i];
    if (segAcc[i] >= T) {
      segAcc[i] -= T;
      passos |= (uint8_t)(1 << i);
      posicao[i] = posicao[i] + segDir[i];
    }
  }
  if (passos) {
    for (uint8_t i = 0; i < N_EIXOS; i++)
      if (passos & (1 << i)) stepAlto(i);
    ATRASO_US(LARGURA_PULSO_US);
    for (uint8_t i = 0; i < N_EIXOS; i++)
      if (passos & (1 << i)) stepBaixo(i);
  }
  const uint32_t prox = segTick + 1;
  segTick = prox;
  if (prox >= T) segAtivo = false;
}

#if defined(__AVR__)
ISR(TIMER1_COMPA_vect) { tickPasso(); }

static void iniciarTimer() {
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = (uint16_t)(F_CPU / 8 / TICK_HZ - 1); // 16 MHz / 8 / 20 kHz - 1 = 99
  TCCR1B |= (1 << WGM12) | (1 << CS11);        // CTC, prescaler 8
  TIMSK1 |= (1 << OCIE1A);
  interrupts();
}
#else
static hw_timer_t *timer = nullptr;
static void ISR_RAM isrTimer() { tickPasso(); }

static void iniciarTimer() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  timer = timerBegin(1000000); // 1 MHz
  timerAttachInterrupt(timer, &isrTimer);
  timerAlarm(timer, 1000000UL / TICK_HZ, true, 0);
#else
  timer = timerBegin(0, 80, true); // 80 MHz / 80 = 1 MHz
  timerAttachInterrupt(timer, &isrTimer, true);
  timerAlarmWrite(timer, 1000000UL / TICK_HZ, true);
  timerAlarmEnable(timer);
#endif
}
#endif

// ---------------------------------------------------------------------------------------
// Fila (lado do loop)

static inline uint8_t segmentosNaFila() { return (uint8_t)((filaCauda + TAM_FILA - filaCabeca) % TAM_FILA); }
static inline bool filaCheia() { return (uint8_t)((filaCauda + 1) % TAM_FILA) == filaCabeca; }
static inline bool parado() { return filaCabeca == filaCauda && !segAtivo; }

static uint32_t usParaTicks(uint32_t us) {
  uint32_t t = (uint32_t)((float)us * (float)TICK_HZ / 1e6f + 0.5f);
  return t ? t : 1;
}

/** Enfileira com as travas: no máximo 1 passo por tick e velMax por eixo. */
static void enfileirar(const int32_t alvo[N_EIXOS], uint32_t ticks) {
  for (uint8_t i = 0; i < N_EIXOS; i++) {
    int32_t dd = alvo[i] - ultimoAlvo[i];
    uint32_t d = dd >= 0 ? (uint32_t)dd : (uint32_t)(-dd);
    if (d > ticks) ticks = d;
    uint32_t tmin = (uint32_t)((float)d * (float)TICK_HZ / (float)velMax[i] + 0.5f);
    if (tmin > ticks) ticks = tmin;
  }
  Segmento &s = fila[filaCauda];
  for (uint8_t i = 0; i < N_EIXOS; i++) {
    s.alvo[i] = alvo[i];
    ultimoAlvo[i] = alvo[i];
  }
  s.ticks = ticks ? ticks : 1;
  filaCauda = (uint8_t)((filaCauda + 1) % TAM_FILA);
}

/** Para na hora: descarta a fila e o segmento atual (a posição continua exata). */
static void esvaziarFila() {
  noInterrupts();
  filaCabeca = filaCauda;
  segAtivo = false;
  for (uint8_t i = 0; i < N_EIXOS; i++) ultimoAlvo[i] = posicao[i];
  interrupts();
}

static uint32_t ticksPendentes() {
  noInterrupts();
  uint32_t t = segAtivo ? (segTicks - segTick) : 0;
  uint8_t i = filaCabeca;
  const uint8_t fim = filaCauda;
  interrupts();
  while (i != fim) {
    t += fila[i].ticks;
    i = (uint8_t)((i + 1) % TAM_FILA);
  }
  return t;
}

static void lerPosicao(int32_t p[N_EIXOS]) {
  noInterrupts();
  for (uint8_t i = 0; i < N_EIXOS; i++) p[i] = posicao[i];
  interrupts();
}

// ---------------------------------------------------------------------------------------
// Estado geral, fins de curso, motores

static uint8_t alarme = 0; // 0 = sem alarme
static bool motoresLigados = false;
static bool referenciado = false;
static uint8_t mascLimite = 0;    // eixos com limite rígido (comando L)
static uint8_t mascInvertido = 0; // eixos com chave NF
static uint8_t finsBruto = 0, finsEstavel = 0, finsAnterior = 0, contEstavel = 0;

static void ligarMotores(bool ligar) {
  for (uint8_t k = 0; k < sizeof(PINOS_EN); k++) digitalWrite(PINOS_EN[k], ligar ? LOW : HIGH);
  motoresLigados = ligar;
}

static uint8_t lerFins() {
  uint8_t m = 0;
  for (uint8_t i = 0; i < N_EIXOS; i++) {
    bool baixo = digitalRead(PINO_FIM[i]) == LOW; // chave NA ao GND com pull-up
    bool inv = (mascInvertido >> i) & 1;
    if (baixo != inv) m |= (uint8_t)(1 << i);
  }
  return m;
}

/** Filtro: a leitura precisa se repetir em 4 voltas do loop. */
static void atualizarFins() {
  uint8_t l = lerFins();
  if (l == finsBruto) {
    if (contEstavel < 3) contEstavel++;
    else finsEstavel = l;
  } else {
    finsBruto = l;
    contEstavel = 0;
  }
}

static inline bool fimAcionado(uint8_t i) { return (finsEstavel >> i) & 1; }

static void emergencia(uint8_t codigo);

// ---------------------------------------------------------------------------------------
// Homing de um eixo: busca rápida, recuo, aproximação lenta, define posição, afasta.

enum FaseHoming : uint8_t { H_NENHUM, H_BUSCA, H_RECUO, H_FINA, H_AFASTAR, H_CONCLUIDO, H_FALHOU };

static struct {
  FaseHoming fase;
  uint8_t eixo;
  int8_t dir;
  uint32_t vRap, vLen, recuo, curso, vAtual;
  int32_t home;
  uint32_t percorrido;
  float frac;
} hom = {H_NENHUM, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0};

static void moverEixo(uint8_t e, int32_t delta, uint32_t vel) {
  int32_t alvo[N_EIXOS];
  for (uint8_t i = 0; i < N_EIXOS; i++) alvo[i] = ultimoAlvo[i];
  alvo[e] += delta;
  uint32_t d = delta >= 0 ? (uint32_t)delta : (uint32_t)(-delta);
  enfileirar(alvo, (uint32_t)((float)d * TICK_HZ / (float)vel) + 1);
}

static void falharHoming() {
  esvaziarFila();
  hom.fase = H_FALHOU;
  alarme = 3;
  Serial.println(F("ALARME 3 falha no homing"));
}

static void atualizarHoming() {
  switch (hom.fase) {
  case H_BUSCA:
  case H_FINA:
    if (fimAcionado(hom.eixo)) {
      esvaziarFila();
      if (hom.fase == H_BUSCA) {
        hom.fase = H_RECUO;
        moverEixo(hom.eixo, -hom.dir * (int32_t)hom.recuo, hom.vLen);
      } else {
        noInterrupts();
        posicao[hom.eixo] = hom.home;
        interrupts();
        ultimoAlvo[hom.eixo] = hom.home;
        hom.fase = H_AFASTAR; // sai de cima da chave
        moverEixo(hom.eixo, -hom.dir * (int32_t)hom.recuo, hom.vLen);
      }
      return;
    }
    if (hom.percorrido > hom.curso) {
      falharHoming();
      return;
    }
    while (segmentosNaFila() < 3) { // ~30 ms de movimento à frente
      float n = hom.vAtual * 0.01f + hom.frac;
      int32_t p = (int32_t)n;
      hom.frac = n - p;
      int32_t alvo[N_EIXOS];
      for (uint8_t i = 0; i < N_EIXOS; i++) alvo[i] = ultimoAlvo[i];
      alvo[hom.eixo] += hom.dir * p;
      enfileirar(alvo, usParaTicks(10000));
      hom.percorrido += (uint32_t)p;
    }
    break;
  case H_RECUO:
    if (parado()) {
      if (fimAcionado(hom.eixo)) {
        falharHoming(); // a chave não soltou
      } else {
        hom.fase = H_FINA;
        hom.vAtual = hom.vLen;
        hom.percorrido = 0;
        hom.frac = 0;
      }
    }
    break;
  case H_AFASTAR:
    if (parado()) {
      hom.fase = H_CONCLUIDO;
      referenciado = true;
    }
    break;
  default:
    break;
  }
}

static int8_t comandoHoming(const long *v, uint8_t n) {
  if (hom.fase == H_CONCLUIDO) {
    hom.fase = H_NENHUM;
    return RESP_OK;
  }
  if (hom.fase == H_FALHOU) {
    hom.fase = H_NENHUM;
    return 4;
  }
  if (hom.fase != H_NENHUM) return RESP_ADIAR;
  // H <eixo> <dir> <vRap> <vLenta> <recuo> <curso> <home>
  if (n != 7 || v[0] < 0 || v[0] >= N_EIXOS || v[2] <= 0 || v[3] <= 0 || v[4] < 0 || v[5] <= 0) return 2;
  if (alarme) return 3;
  if (!motoresLigados) return 6;
  if (!parado()) return RESP_ADIAR;
  hom.eixo = (uint8_t)v[0];
  hom.dir = v[1] > 0 ? 1 : -1;
  hom.vRap = (uint32_t)v[2];
  hom.vLen = (uint32_t)v[3];
  hom.recuo = (uint32_t)v[4];
  hom.curso = (uint32_t)v[5];
  hom.home = (int32_t)v[6];
  hom.percorrido = 0;
  hom.frac = 0;
  if (fimAcionado(hom.eixo)) { // já está na chave: recua antes
    hom.fase = H_RECUO;
    moverEixo(hom.eixo, -hom.dir * (int32_t)hom.recuo, hom.vLen);
  } else {
    hom.fase = H_BUSCA;
    hom.vAtual = hom.vRap;
  }
  return RESP_ADIAR;
}

// ---------------------------------------------------------------------------------------
// Emergência e limites

static void emergencia(uint8_t codigo) {
  esvaziarFila();
  if (hom.fase != H_NENHUM && hom.fase != H_CONCLUIDO) hom.fase = H_FALHOU;
  if (alarme == 0) {
    alarme = codigo;
    Serial.print(F("ALARME "));
    Serial.print(codigo);
    Serial.println(codigo == 2 ? F(" fim de curso") : codigo == 4 ? F(" botao de emergencia") : F(" parada de emergencia"));
  }
}

static void verificarLimites() {
  // limite rígido: chave que ACIONA durante um movimento (fora do homing)
  uint8_t novos = finsEstavel & ~finsAnterior & mascLimite;
  if (novos && hom.fase == H_NENHUM && !parado()) emergencia(2);
  finsAnterior = finsEstavel;
#if USAR_BOTAO_EMERGENCIA
  static bool botaoAnterior = false;
  bool botao = digitalRead(PINO_EMERGENCIA) == HIGH;
  if (botao && !botaoAnterior) emergencia(4);
  botaoAnterior = botao;
#endif
}

// ---------------------------------------------------------------------------------------
// Serial: caracteres de tempo real são tratados na chegada; o resto vai para um buffer
// circular de TAM_RX bytes (o app nunca envia mais do que isso sem receber "ok").

static char rx[TAM_RX];
static uint16_t rxIni = 0, rxFim = 0;
static char linha[TAM_LINHA];
static uint8_t tamLinha = 0;
static bool linhaPronta = false, linhaLonga = false, estouroRx = false;
static bool pedidoStatus = false;

static void lerSerial() {
  while (Serial.available()) {
    int c = Serial.read();
    if (c == '?') {
      pedidoStatus = true;
      continue;
    }
    if (c == '!') {
      emergencia(1);
      continue;
    }
    uint16_t prox = (uint16_t)((rxFim + 1) % TAM_RX);
    if (prox == rxIni) {
      estouroRx = true;
      continue;
    }
    rx[rxFim] = (char)c;
    rxFim = prox;
  }
}

static void montarLinha() {
  while (!linhaPronta && rxIni != rxFim) {
    char c = rx[rxIni];
    rxIni = (uint16_t)((rxIni + 1) % TAM_RX);
    if (c == '\r') continue;
    if (c == '\n') {
      linha[tamLinha] = 0;
      linhaPronta = true;
    } else if (tamLinha < TAM_LINHA - 1) {
      linha[tamLinha++] = c;
    } else {
      linhaLonga = true;
    }
  }
}

static uint8_t lerNumeros(const char *p, long *v, uint8_t max) {
  uint8_t n = 0;
  while (*p) {
    while (*p == ' ') p++;
    if (!*p) break;
    char *fim;
    long x = strtol(p, &fim, 10);
    if (fim == p) return 255; // texto não numérico
    if (n < max) v[n] = x;
    n++;
    p = fim;
  }
  return n;
}

static void imprimirHello() {
  Serial.print(F("BRACO " VERSAO " eixos=" ));
  Serial.print(N_EIXOS);
  Serial.print(F(" tick="));
  Serial.print(TICK_HZ);
  Serial.print(F(" rx="));
  Serial.print(TAM_RX);
  Serial.print(F(" fila="));
  Serial.print(TAM_FILA - 1);
  Serial.print(F(" ref="));
  Serial.println(referenciado ? 1 : 0);
}

static void imprimirStatus() {
  int32_t p[N_EIXOS];
  lerPosicao(p);
  const bool par = parado();
  Serial.print('<');
  if (alarme) {
    Serial.print(F("ALARME:"));
    Serial.print(alarme);
  } else if (hom.fase != H_NENHUM) {
    Serial.print(F("HOMING"));
  } else {
    Serial.print(par ? F("OCIOSO") : F("MOVENDO"));
  }
  Serial.print('|');
  for (uint8_t i = 0; i < N_EIXOS; i++) {
    if (i) Serial.print(',');
    Serial.print(p[i]);
  }
  Serial.print('|');
  Serial.print(segmentosNaFila() + (segAtivo ? 1 : 0));
  Serial.print('|');
  Serial.print((uint32_t)((uint64_t)ticksPendentes() * 1000UL / TICK_HZ));
  Serial.print('|');
  for (uint8_t i = 0; i < N_EIXOS; i++) Serial.print(fimAcionado(i) ? '1' : '0');
  Serial.print('|');
  Serial.print(motoresLigados ? '1' : '0');
  Serial.print('|');
  Serial.print(referenciado ? '1' : '0');
  Serial.println('>');
}

static int8_t executar(const char *l) {
  while (*l == ' ') l++;
  const char cmd = *l;
  if (!cmd) return RESP_NADA;
  long v[8];
  const uint8_t n = lerNumeros(l + 1, v, 8);
  if (n == 255) return 2;
  switch (cmd) {
  case 'V':
    imprimirHello();
    return RESP_OK;
  case 'S': {
    if (n != 5 || v[0] <= 0) return 2;
    if (alarme) return 3;
    if (!motoresLigados) return 6;
    if (hom.fase != H_NENHUM || filaCheia()) return RESP_ADIAR;
    int32_t alvo[N_EIXOS];
    for (uint8_t i = 0; i < N_EIXOS; i++) alvo[i] = (int32_t)v[i + 1];
    enfileirar(alvo, usParaTicks((uint32_t)v[0]));
    return RESP_OK;
  }
  case 'Z':
    if (n != N_EIXOS) return 2;
    if (!parado()) return RESP_ADIAR;
    noInterrupts();
    for (uint8_t i = 0; i < N_EIXOS; i++) posicao[i] = (int32_t)v[i];
    interrupts();
    for (uint8_t i = 0; i < N_EIXOS; i++) ultimoAlvo[i] = (int32_t)v[i];
    referenciado = true;
    return RESP_OK;
  case 'E':
    if (n != 1) return 2;
    if (!parado()) return RESP_ADIAR;
    ligarMotores(v[0] != 0);
    return RESP_OK;
  case 'M':
    if (n != N_EIXOS) return 2;
    for (uint8_t i = 0; i < N_EIXOS; i++)
      if (v[i] <= 0) return 2;
    for (uint8_t i = 0; i < N_EIXOS; i++) velMax[i] = (uint32_t)v[i];
    return RESP_OK;
  case 'L':
    if (n != 2) return 2;
    mascLimite = (uint8_t)v[0];
    mascInvertido = (uint8_t)v[1];
    return RESP_OK;
  case 'X':
    alarme = 0;
    return RESP_OK;
  case 'W':
    return parado() && hom.fase == H_NENHUM ? RESP_OK : RESP_ADIAR;
  case 'H':
    return comandoHoming(v, n);
  default:
    return 1;
  }
}

static void processarLinha() {
  if (!linhaPronta) montarLinha();
  if (!linhaPronta) return;
  int8_t r = linhaLonga ? 7 : executar(linha);
  if (r == RESP_ADIAR) return;
  if (r == RESP_OK) Serial.println(F("ok"));
  else if (r > 0) {
    Serial.print(F("erro "));
    Serial.println(r);
  }
  linhaPronta = false;
  linhaLonga = false;
  tamLinha = 0;
}

// ---------------------------------------------------------------------------------------

void setup() {
  Serial.begin(BAUD);
  for (uint8_t k = 0; k < sizeof(PINOS_EN); k++) {
    pinMode(PINOS_EN[k], OUTPUT);
    digitalWrite(PINOS_EN[k], HIGH); // drivers desligados ao ligar
  }
  for (uint8_t i = 0; i < N_EIXOS; i++) {
    pinMode(PINO_STEP[i], OUTPUT);
    pinMode(PINO_DIR[i], OUTPUT);
    digitalWrite(PINO_STEP[i], LOW);
    pinMode(PINO_FIM[i], INPUT_PULLUP);
    posicao[i] = 0;
    ultimoAlvo[i] = 0;
#if defined(__AVR__)
    regStep[i] = portOutputRegister(digitalPinToPort(PINO_STEP[i]));
    mskStep[i] = digitalPinToBitMask(PINO_STEP[i]);
    regDir[i] = portOutputRegister(digitalPinToPort(PINO_DIR[i]));
    mskDir[i] = digitalPinToBitMask(PINO_DIR[i]);
#else
    mskStep[i] = 1UL << PINO_STEP[i];
    mskDir[i] = 1UL << PINO_DIR[i];
#endif
  }
#if USAR_BOTAO_EMERGENCIA
  pinMode(PINO_EMERGENCIA, INPUT_PULLUP);
#endif
  finsBruto = finsEstavel = finsAnterior = lerFins();
  iniciarTimer();
  imprimirHello();
}

void loop() {
  lerSerial();
  atualizarFins();
  verificarLimites();
  atualizarHoming();
  if (pedidoStatus) {
    pedidoStatus = false;
    imprimirStatus();
  }
  processarLinha();
  if (estouroRx) {
    estouroRx = false;
    Serial.println(F("MSG estouro do buffer de recepcao"));
  }
}
