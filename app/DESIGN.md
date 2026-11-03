# Design: mesa de estúdio

Contrato visual do app. Toda tela nova usa estes tokens e peças; se faltar algo, acrescente aqui antes de usar.

## Ideia

O programa é um equipamento de estúdio. O trabalho é uma cadeia de sinal: **Entrada → Versão → Saída**, três módulos lado a lado numa tela só. O progresso é a fileira de lâmpadas no rodapé, visível em qualquer aba; uma gravação em andamento nunca perde a tela.

Detalhe de assinatura: o **fader de tom** vertical com travas em −12, −7, −5, 0, +5, +7, +12.

## Cores (em `renderer/style.css`, `:root`)

| Token | Valor | Papel |
|---|---|---|
| `--chassi` | `#1f1c19` | fundo: grafite quente, não preto |
| `--painel` | `#2b2723` | módulos |
| `--painel-2` / `--painel-3` | `#36312c` / `#403a34` | teclas; tecla acesa ou sob o cursor |
| `--sulco` | `#151311` | rebaixos: visores, campos, trilhos, janelas de onda |
| `--aresta` | `#4a433c` | quina iluminada no topo das peças |
| `--serigrafia` | `#e8dec8` | texto principal, como letra impressa no painel |
| `--aco` | `#9a9186` | texto secundário |
| `--ambar` | `#f2a93b` | lâmpada acesa, visor, seleção, o que está tocando |
| `--verde` | `#86c96a` | sinal presente, etapa concluída |
| `--vermelho` | `#d5402f` | só gravar e erro |

Cor tem função. Âmbar = ativo ou selecionado. Verde = pronto. Vermelho = gravar ou falha. Nada de cor decorativa.

Exceção deliberada: a **partitura** é papel (`#f3ecdc`), clara dentro do equipamento escuro.

## Tipos

- **Barlow Semi Condensed 600**, caixa alta, espaçada (`.etq`): só rótulos de módulo e teclas, como num aparelho.
- **Barlow 400/500**: todo o resto, em frase normal.
- **Chivo Mono**: visores, tempos, sementes. Só dado que se lê como número.

Fontes ficam em `renderer/fonts/` (licença OFL), o app funciona sem internet.

## Peças

- `.modulo` + `.mod-cab` (rótulo à esquerda, lâmpada à direita).
- `.lamp` com estados `on` (âmbar), `sinal` (verde), `erro`, `pisca` (trabalhando).
- `.campo`: rebaixado. `.tecla`: saliente, com `p` (pequena), `larga`, `forte` (ação principal fora da mesa).
- `.chave`: interruptor (`role="switch"`, `aria-checked`).
- `.visor`: leitura em âmbar sobre `--sulco`.
- `.canal`: tocar, janela com forma de onda real, medidor, Salvar/Pasta. A janela arrasta o arquivo para fora do app.
- `.rec`: o único botão redondo e vermelho. Durante o trabalho vira Parar.
- `dialog.painel`: ajustes e partitura.

## Regras

- Relevo: aresta clara em cima, sombra dura de 2px embaixo. Raio 3px nas peças, 5px nos módulos. Sem sombra difusa, sem gradiente decorativo.
- Texto de interface em português, direto: diz o que o controle faz ("Gravar", "Parar", "Separar esta variação").
- Foco de teclado sempre visível (contorno âmbar). Animações desligam com `prefers-reduced-motion`.
- Nome do programa vem de `APP_NAME` em `src/config.js`.
