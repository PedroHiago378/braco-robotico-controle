// Configuração de hardware do firmware do braço RRRR.
// A placa é detectada pelo tipo de microcontrolador selecionado na Arduino IDE.
// Ordem dos eixos: 0 = base, 1 = ombro, 2 = cotovelo, 3 = punho.
#pragma once

#define BAUD 115200
#define N_EIXOS 4

// Largura do pulso STEP. 2 µs atende A4988 (1 µs), DRV8825 (1,9 µs) e TMC2209.
#define LARGURA_PULSO_US 2

// Botão de emergência físico (opcional). Ligue um botão NF entre o pino e o GND:
// pressionado (ou fio rompido) = pino em HIGH = emergência. Deixe 0 se não houver botão,
// senão o pino solto em HIGH mantém o firmware em alarme.
#define USAR_BOTAO_EMERGENCIA 0

#if defined(ARDUINO_ARCH_ESP32)
// ---- ESP32 (DevKit) + 4 drivers avulsos ----------------------------------------------
// STEP e DIR precisam estar abaixo do GPIO 32 (escrita direta em registrador).
// Evite 16/17 em módulos WROVER (PSRAM).
#define TICK_HZ 40000UL
#define TAM_FILA 128
#define TAM_RX 1024
static const uint8_t PINO_STEP[N_EIXOS] = {26, 25, 16, 18};
static const uint8_t PINO_DIR[N_EIXOS] = {27, 14, 17, 19};
static const uint8_t PINO_FIM[N_EIXOS] = {21, 22, 23, 32};
static const uint8_t PINOS_EN[] = {13};
#define PINO_EMERGENCIA 33

#elif defined(__AVR_ATmega2560__)
// ---- Arduino Mega 2560 + RAMPS 1.4: X, Y, Z, E0 ----------------------------------------
#define TICK_HZ 20000UL
#define TAM_FILA 48
#define TAM_RX 256
static const uint8_t PINO_STEP[N_EIXOS] = {54, 60, 46, 26};
static const uint8_t PINO_DIR[N_EIXOS] = {55, 61, 48, 28};
static const uint8_t PINO_FIM[N_EIXOS] = {3, 14, 18, 2}; // X-min, Y-min, Z-min, X-max
static const uint8_t PINOS_EN[] = {38, 56, 62, 24};
#define PINO_EMERGENCIA 19 // Z-max

#elif defined(__AVR__)
// ---- Arduino Uno + CNC Shield V3: X, Y, Z, A ---------------------------------------------
// Eixo A: jumpers no shield ligando A.STEP ao D12 e A.DIR ao D13.
#define TICK_HZ 20000UL
#define TAM_FILA 32
#define TAM_RX 128
static const uint8_t PINO_STEP[N_EIXOS] = {2, 3, 4, 12};
static const uint8_t PINO_DIR[N_EIXOS] = {5, 6, 7, 13};
static const uint8_t PINO_FIM[N_EIXOS] = {9, 10, 11, A0}; // X-, Y-, Z-, Abort
static const uint8_t PINOS_EN[] = {8};
#define PINO_EMERGENCIA A1 // Hold

#else
#error "Placa não suportada: ajuste config.h"
#endif

#if TAM_FILA > 255
#error "TAM_FILA deve caber em uint8_t"
#endif
