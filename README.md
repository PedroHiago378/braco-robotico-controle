# Controle do braço RRRR (4 × Nema 17)

Programa completo de controle para o braço de 4 juntas rotacionais do estudo em
`Projetos/braco-robotico` (yaw na base + ombro, cotovelo e punho em pitch):

- **Cinemática inversa analítica** com até 4 soluções (cotovelo cima/baixo × base frente/atrás), escolha da mais próxima, φ livre quando a orientação pedida é inalcançável, jacobiano e avisos de singularidade.
- **Visualização 3D** (Three.js): braço real e alvo (fantasma), gizmo para arrastar a ponta, trilha, caminho da timeline com keyframes clicáveis e região alcançável no plano do braço.
- **Controle dinâmico**: o robô segue o alvo ao vivo (por juntas ou com a ponta em reta), respeitando velocidade e aceleração de cada junta.
- **Timeline com keyframes**: interpolação suave, spline, linear ou cartesiana; verificação de velocidade, aceleração, limites, alcance e torque estático; ajuste automático de tempos; prévia; execução com pausa/retomada em rampa e loop.
- **Módulos de controle**: planejador de trajetória (junta sincronizada e linear cartesiana), controlador de streaming, trava de segurança, homing por fim de curso, referência manual, parada de emergência, monitor de torque.
- **Configuração do braço**: geometria, limites, motores (passos, micropassos, redução, sentido), velocidades, fins de curso, massas, salva no navegador e em JSON.
- **Simulador do firmware**: o app inteiro funciona sem o braço (é o modo padrão).
- **Firmware** para Arduino Uno + CNC Shield V3, Mega 2560 + RAMPS 1.4 ou ESP32.

## Rodar o app

Requer Node.js 18 ou mais novo.

```bash
npm install
```

```bash
npm run dev
```

Abre em `http://localhost:5173`. Para falar com o Arduino pela USB use **Chrome ou Edge** (Web Serial). Sem hardware, o simulador conecta sozinho.

Outros comandos: `npm test` (testes do núcleo), `npm run build` (gera `dist/`), `npm run preview` (serve o `dist/` em localhost; Web Serial não funciona abrindo o arquivo direto).

## Uso

| Ação | Como |
|---|---|
| Mover uma junta | Sliders, botões −/+ ou número (aba Controle) |
| Mover a ponta | Arraste as setas do gizmo 3D, ou X/Y/Z/φ na aba Controle |
| Robô segue o alvo | "Seguir alvo ao vivo" (por juntas ou cartesiano). Desligado: use "Mover (juntas)" / "Mover (linear)" |
| Velocidade geral | Slider "Velocidade" no topo (escala velocidade e aceleração de tudo) |
| Keyframe | Posicione o cursor da timeline, componha a pose e pressione **K**. Com o cursor no fim, K adiciona depois do último com tempo calculado pelos limites |
| Editar keyframe | Clique no losango (ou na esfera roxa no 3D). Arraste para mudar o tempo (Alt desliga o encaixe de 0,05 s). Duplo clique leva o alvo até ele |
| Verificar / corrigir | Trechos com problema ficam em vermelho (laranja = torque). "Ajustar tempos" estica o que passa de velocidade/aceleração |
| Prévia | **Espaço** anima o fantasma sem mover o robô |
| Executar | "Executar no robô" leva o braço ao ponto do cursor e roda dali. Espaço pausa/continua com rampa |
| Emergência | Botão vermelho ou **Esc**: esvazia a fila e trava o firmware. Destrave na aba Conexão |

Atalhos: `K` keyframe, `Shift+K` keyframe no fim, `Delete` exclui, `←`/`→` keyframe anterior/próximo, `Home`/`End`, `Espaço`, `Esc`.

Interpolações (definidas no keyframe de saída do trecho):

- **Suave**: para em cada keyframe (quíntica, velocidade e aceleração zero nas pontas). Padrão seguro.
- **Spline**: passa pelos keyframes sem parar (Hermite monotônica, não ultrapassa os valores dos keyframes).
- **Linear**: velocidade constante. Gera tranco nos keyframes; a verificação acusa.
- **Linear cartesiana**: a ponta anda em reta entre os dois keyframes. Os dois precisam estar na mesma configuração (cotovelo e base).

## Convenções

Mesmas do estudo de viabilidade:

- Frame do robô: origem no eixo da base, sobre a mesa; z para cima.
- `q1` base (yaw). `t1` ombro, absoluto a partir da horizontal. `t2` cotovelo e `t3` punho, relativos ao elo anterior. Positivo = para cima.
- φ = elevação da ferramenta, medida a partir da direção radial "para fora": 0 horizontal, −90 apontando para baixo.

## Valores padrão e suposições

Do CAD: L1 = L2 = 190 mm, ombro 49,82 mm atrás do eixo da base e 117,37 mm acima do fundo da placa de montagem, redutor 18,204:1 em todas as juntas, limite do cotovelo ±90°.

**Suposições a confirmar** (aba Configuração): ferramenta L3 = 100 mm, 16 micropassos, limites da base/ombro/punho, pose inicial `[0, 60, −60, 0]`, massas do estudo e capacidade 3,35 N·m por junta (ensaio de 5,03 N·m com fator 1,5).

## Modelo 3D do CAD

A vista 3D desenha as peças do STEP (`public/modelos/braco.glb`), uma parte rígida por junta. O botão "CAD" na vista alterna para o modelo simplificado. Depois de alterar o STEP, gere o GLB de novo:

```bash
npm run importar-step -- "C:/Users/pedro/OneDrive/Desktop/modelos/braço.step"
```

O conversor separa as peças sozinho: acha os 4 redutores pelo flange de saída (45 × 45 × 11 mm), monta a cadeia pela distância entre eles e distribui o resto pelo contato entre peças. Ele imprime a geometria e a pose em que o CAD está; se a geometria da configuração for diferente, o app avisa e oferece "Usar geometria do CAD" na aba Configuração.

O CAD não tem ferramenta: o app desenha uma haste de L3 no plano do braço. A face do flange do punho fica cerca de 17 mm para o lado desse plano, e a cinemática ainda não considera esse deslocamento lateral.

As velocidades padrão são conservadoras (ombro 30 °/s, 60 °/s²) porque o estudo mostrou o ombro no limite de torque com o braço estendido. O monitor de torque na aba Controle e a verificação da timeline usam esse modelo.

Com 16 micropassos e 18,2:1 são 161,8 passos/grau. O Uno gera até 20 000 passos/s por eixo (cerca de 117 °/s na junta); o ESP32, 40 000. A aba Configuração mostra o limite de cada junta.

## Hardware

### Arduino Uno + CNC Shield V3 (padrão)

| Junta | Slot do driver | Fim de curso |
|---|---|---|
| Base | X | X− (D9) |
| Ombro | Y | Y− (D10) |
| Cotovelo | Z | Z− (D11) |
| Punho | A (jumpers A.STEP→D12, A.DIR→D13) | Abort (A0) |

- Micropassos 1/16: A4988 com MS1, MS2 e MS3 fechados; DRV8825 só com M2 fechado.
- Corrente: ajuste o Vref para 70–80% da corrente nominal do motor. DRV8825: Vref = I/2. A4988: Vref = 8 · I · Rsense (veja o resistor da placa, 0,1 Ω ou 0,068 Ω).
- Fonte de 12–24 V no borne do shield. Nunca conecte nem desconecte motores com a fonte ligada.
- Fins de curso: chave NA entre o sinal e o GND (pull-up interno). Chave NF: marque "Chave NF" na configuração.
- O pino 13 também acende o LED do Uno; é normal piscar com o punho.

Mega 2560 + RAMPS 1.4 e ESP32: pinos em `firmware/braco_firmware/config.h`. A placa é detectada pelo tipo selecionado na Arduino IDE.

### Emergência

O botão do app e o `Esc` param pela USB. Para segurança real, instale um **botão de emergência físico cortando a alimentação dos motores** (12–24 V). Opcionalmente, um botão NF entre A1 (Hold) e o GND gera alarme no firmware: ative `USAR_BOTAO_EMERGENCIA` em `config.h`.

Os drivers não têm freio: desligar os motores, ou cortar a fonte, deixa o braço cair por gravidade se o redutor não segurar.

## Firmware

1. Abra `firmware/braco_firmware/braco_firmware.ino` na Arduino IDE (não precisa de bibliotecas).
2. Selecione a placa (Uno, Mega 2560 ou ESP32 Dev Module) e a porta, e grave.
3. No app, aba Conexão: "Serial USB", baud 115200, Conectar, e escolha a porta.

O firmware liga com os drivers **desligados** e sem referência. Ao conectar, o app assume que o braço está na pose inicial. O firmware só gera passos: todo o planejamento fica no app, que envia segmentos de 20 ms (posições absolutas em passos) mantendo cerca de 250 ms na fila. Ele também aplica duas travas próprias: no máximo um passo por tick e a velocidade máxima por eixo enviada pelo app.

Protocolo (texto, uma linha por comando, resposta `ok` ou `erro N`): descrito em `src/hardware/protocolo.js`. Dá para testar no Monitor Serial da IDE (115200, fim de linha "Nova linha"): `V`, `?`, `E 1`, `S 1000000 1618 0 0 0` (base +10° em 1 s), `!`, `X`.

## Primeiro uso com o braço

1. Com a fonte dos motores desligada, conecte o app e confira o status (aba Conexão).
2. Posicione o braço à mão na **pose inicial** (ou ajuste a pose inicial na configuração para uma posição fácil de reproduzir) e clique "Ref. = pose inicial".
3. Ligue a fonte e depois "Ligar motores". Ponha a velocidade geral em 10–20%.
4. Mova **uma junta de cada vez** poucos graus. Se girar ao contrário, marque "Inverter sentido" dessa junta e aplique.
5. Confira os limites de cada junta devagar e ajuste mínimo/máximo. Meça o comprimento da ferramenta.
6. Com fins de curso: configure ângulo, sentido de busca e ordem, e use "Homing".
7. Só então aumente velocidades e rode a timeline, primeiro na prévia.

## Estrutura

```
src/nucleo/        lógica pura (testada em Node, sem DOM)
  config.js          configuração padrão, conversão graus <-> passos, validação
  cinematica.js      direta, inversa, jacobiano, singularidades, região alcançável
  perfis.js          trapezoidal, quíntica, Hermite
  trajetoria.js      movimento de junta sincronizado e linear cartesiano
  timeline.js        keyframes, interpolação, verificação, ajuste de tempos, JSON
  controlador.js     streaming de segmentos: seguir, trajetória, timeline, frenagem
  operacoes.js       conectar, referenciar, homing, motores, destravar
  torque.js          torque estático por gravidade
src/hardware/
  protocolo.js       formato das mensagens
  link.js            fila de comandos com controle de fluxo
  serial.js          Web Serial
  simulador.js       firmware virtual
  relogio.js         relógio em Web Worker (aba em segundo plano não para o streaming)
src/ui/             interface (3D, painéis, editor de timeline)
public/modelos/     braco.glb gerado do STEP
ferramentas/        importar-step.mjs (STEP -> GLB por junta)
firmware/           Arduino/ESP32
exemplos/           timeline de demonstração (pega e solta)
testes/             node --test
```

Deixe a aba do app aberta durante a execução de um programa: o relógio roda em Worker para não parar em segundo plano, mas fechar ou recarregar a página interrompe o envio e o braço para quando a fila (≈250 ms) acaba.
