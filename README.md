# braco-robotico-controle

Software para controlar um braço robótico de 4 juntas rotacionais (base em yaw; ombro, cotovelo e punho em pitch), movido por 4 motores Nema 17 com redutor planetário impresso de 18,2:1.

São duas partes. O app web faz a cinemática, o planejamento de movimento e a interface 3D. O firmware, para Arduino ou ESP32, só gera os pulsos de passo. Sem o braço montado, o app usa um simulador do firmware.

## Rodando

```bash
npm install
npm run dev
```

Abre em http://localhost:5173. A conexão USB usa Web Serial, então só funciona no Chrome ou no Edge. `npm test` roda os testes.

## Uso

Na aba Controle você move cada junta pelos sliders ou arrasta a ponta da ferramenta no 3D, e a cinemática inversa resolve os ângulos. Com "Seguir alvo ao vivo" ligado, o braço acompanha o alvo respeitando a velocidade e a aceleração de cada junta.

A timeline grava keyframes (tecla K) e interpola entre eles de quatro jeitos: suave (para em cada keyframe), spline (passa direto), linear e linear cartesiana (ponta em linha reta). O app confere velocidade, aceleração, limites, alcance e torque estático e marca em vermelho os trechos com problema. "Ajustar tempos" estica o que estiver rápido demais.

A aba Configuração guarda geometria, limites, motores, velocidades, fins de curso e massas. Fica salva no navegador e pode ser exportada em JSON.

Atalhos: K keyframe, Shift+K keyframe no fim, Espaço prévia ou pausa, ←/→ entre keyframes, Delete apaga, Esc parada de emergência.

## Convenções

- Origem no eixo da base, na altura da mesa, z para cima.
- q1 é o yaw da base. t1 (ombro) é medido a partir da horizontal; t2 (cotovelo) e t3 (punho) são relativos ao elo anterior. Positivo é para cima.
- φ é a inclinação da ferramenta em relação à horizontal, olhando para fora do eixo da base: 0 é horizontal, −90 aponta para baixo.

## Geometria

Do CAD: L1 = L2 = 190 mm, ombro 49,82 mm atrás do eixo da base e 117,37 mm acima da placa de montagem, redução 18,204:1 em todas as juntas.

Ainda são estimativas: ferramenta de 100 mm, 16 micropassos, limites da base, do ombro e do punho, massas e capacidade de 3,35 N·m por junta. As velocidades padrão são baixas (ombro a 30 °/s) porque o ombro fica perto do limite de torque com o braço esticado.

## Modelo 3D

`public/modelos/braco.glb` é gerado a partir do STEP do braço:

```bash
npm run importar-step -- caminho/para/braço.step
```

O script acha os quatro redutores pelo flange de saída (45 × 45 × 11 mm), monta a cadeia e distribui as outras peças pelo contato entre elas. Se a geometria configurada não bater com a do CAD, o app avisa.

O CAD ainda não tem ferramenta. A face do flange do punho fica uns 17 mm fora do plano do braço, e a cinemática não leva isso em conta.

## Hardware

Placa padrão: Arduino Uno com CNC Shield V3.

| Junta | Driver | Fim de curso |
|---|---|---|
| Base | X | D9 (X−) |
| Ombro | Y | D10 (Y−) |
| Cotovelo | Z | D11 (Z−) |
| Punho | A, com jumpers A.STEP→D12 e A.DIR→D13 | A0 (Abort) |

Para 1/16 de micropasso, feche MS1, MS2 e MS3 no A4988, ou só M2 no DRV8825. Ajuste o Vref para 70 a 80% da corrente do motor (no DRV8825, Vref = I/2). Os fins de curso são chaves NA ligadas ao GND.

Os pinos do Mega com RAMPS 1.4 e do ESP32 estão em `firmware/braco_firmware/config.h`.

O botão de emergência do app só atua pela USB. Instale um botão físico que corte a alimentação dos motores. Sem corrente nos motores, o braço pode cair.

## Firmware

Abra `firmware/braco_firmware/braco_firmware.ino` na Arduino IDE, escolha a placa e grave. Não usa bibliotecas.

O app envia segmentos de 20 ms com posições absolutas em passos e mantém uns 250 ms na fila do firmware. O protocolo é texto, uma linha por comando, e está descrito em `src/hardware/protocolo.js`. Dá para testar pelo Monitor Serial (115200, "Nova linha"): `V`, `?`, `E 1`, `S 1000000 1618 0 0 0`, `!`, `X`.

O firmware liga com os motores desligados. Sem fins de curso, coloque o braço à mão na pose inicial antes de ligar os motores e use "Ref. = pose inicial" na aba Conexão. No primeiro teste, deixe a velocidade em 10 a 20% e mova uma junta por vez. Se alguma girar ao contrário, marque "Inverter sentido" nela.

## Organização

```
src/nucleo/     cinemática, trajetórias, timeline e controlador (sem DOM, testado em Node)
src/hardware/   protocolo, Web Serial e simulador do firmware
src/ui/         interface
firmware/       Arduino e ESP32
ferramentas/    conversor STEP -> GLB
testes/
```
