<p align="center">
  <img src="../assets/banner.svg" width="900" alt="hivedesk: uma equipe inteira de agentes de IA rodando na sua própria máquina. Uma área de trabalho em favo de mel com linha do tempo, chat da equipe, janela de código e prévia ao vivo, com Mel, a abelha mestre de obras.">
</p>

<p align="center"><b>Um comando. Uma equipe inteira de IA na sua máquina.</b></p>

<p align="center">
  <a href="https://kwy404.github.io/hivedesk/">Site</a> &middot;
  <a href="#instalar">Instalar</a> &middot;
  <a href="#sincero-sobre-os-limites">Limites</a> &middot;
  <a href="#empreste-seu-pc">Empreste seu PC</a> &middot;
  <a href="../README.md">English</a>
</p>

Rode `npx hivedesk` e ele faz o resto: verifica o seu hardware, instala o runtime local, baixa o modelo certo com uma barra de progresso e abre a Colmeia no navegador. A Colmeia é uma área de trabalho onde uma equipe de agentes de IA planeja, conversa entre si e cria arquivos de verdade numa pasta do seu computador, com um modelo que roda na sua própria máquina. Sem conta e sem chave de API.

<p align="center">
  <img src="../docs/assets/shots/hive.png" width="900" alt="A Colmeia: caixa de pedido, linha do tempo das tarefas e status do modelo no topo, janelas com o chat da equipe, arquivos com diff, código, log de execução e prévia ao vivo, e um dock com os avatares da equipe.">
</p>

## Instalar

```bash
npx hivedesk
```

Essa é toda a configuração. Na primeira execução, o hivedesk:

1. inicia um servidor em `127.0.0.1` com um token secreto na URL e abre o navegador, que mostra uma barra de progresso enquanto o resto acontece;
2. usa o Ollama ou o LM Studio se um deles já estiver rodando com um modelo, e pula o download;
3. detecta o hardware: sistema, núcleos da CPU, RAM, disco livre e a GPU com a VRAM;
4. instala o runtime local `node-llama-cpp` em `~/.hivedesk/runtime/`, uma vez só (ele não é dependência do pacote, então o `npx hivedesk` continua leve);
5. escolhe um modelo dos repositórios oficiais da Qwen no Hugging Face e baixa em `~/.hivedesk/models/`, mostrando nome, tamanho e origem; um download interrompido continua de onde parou, e o arquivo é conferido com o SHA-256 publicado;
6. carrega o modelo, na GPU quando possível, e a equipe avisa que está pronta.

<p align="center">
  <img src="../assets/illustrations/first-run.svg" width="900" alt="Um terminal rodando npx hivedesk: detecta uma GTX 1060 de 6 GB, instala o node-llama-cpp, escolhe o Qwen2.5-Coder 7B, 4,7 GB de huggingface.co/Qwen, e mostra a barra de download. Ao lado, quatro passos: detectar o hardware, instalar o runtime, baixar o modelo, abrir a Colmeia.">
</p>

| Seu hardware | Modelo (Q4_K_M) | Download |
| --- | --- | --- |
| GPU com 6 GB de VRAM ou mais | Qwen2.5-Coder 7B Instruct | 4,7 GB |
| GPU com 3,5 GB ou mais, ou sem GPU e com 16 GB de RAM | Qwen2.5-Coder 3B Instruct | 2,1 GB |
| Qualquer outro caso | Qwen2.5-Coder 1.5B Instruct | 1,1 GB |

**Quanto tempo leva a primeira execução.** Quase tudo é o download do modelo, mais algumas centenas de MB do runtime. A 100 Mbit/s, o modelo 7B leva uns 6 minutos, o 3B uns 3 e o 1.5B menos de 2; a 25 Mbit/s, multiplique por quatro. Como referência, o modelo de 2,1 GB levou 10 minutos na conexão em que testamos. A segunda execução pula a instalação e o download e fica pronta em segundos, o tempo de carregar o modelo na memória.

O comportamento exato, inclusive quando falta disco, a rede cai ou a GPU falha, está no [FIRST-RUN.md](../FIRST-RUN.md) (em inglês).

### Requisitos

- Node.js 18 ou mais novo, no Windows, macOS ou Linux.
- Disco livre para o modelo (1,1 a 4,7 GB) e até uns 0,7 GB para o runtime. Se faltar espaço, o hivedesk escolhe um modelo menor que caiba, ou para antes de baixar.
- GPU é opcional: NVIDIA, Apple Silicon e outras pelo runtime. Sem GPU ele roda na CPU, devagar.
- Conexão com a internet só na primeira execução.
- Um navegador atual.

### Opções

| Opção | O que faz |
| --- | --- |
| `--demo` | Sem modelo nenhum: um trabalho roteirizado é reproduzido para você conhecer a Colmeia. Todo evento aparece marcado como demo. |
| `--brain ollama`, `--brain lmstudio` | Usa só esse servidor de modelos. |
| `--brain openai --url <url>` | Qualquer endpoint compatível com a API da OpenAI, com a chave na variável `HIVEDESK_API_KEY`. |
| `--model <caminho ou uri>` | Usa este arquivo GGUF (um caminho local, ou uma URI `hf:` ou `https:`). |
| `--no-download` | Nunca baixa; a Colmeia oferece um botão de download. |
| `--dir <caminho>` | A pasta em que a equipe trabalha. Padrão: a pasta atual. |
| `--port <n>`, `--no-open` | Escolhe a porta; não abre o navegador. |
| `--doctor` | Mostra as verificações (Node, GPU, RAM, disco, modelos encontrados) e sai. |
| `--lend` | Empresta o seu modelo a um amigo (veja abaixo). |

`HIVEDESK_HOME` muda a pasta de cache `~/.hivedesk/`.

## Sincero sobre os limites

Um modelo pequeno na sua máquina é privado e não custa nada para rodar. Também é mais lento e menos capaz que os maiores modelos em um data center. Leia isto antes de começar.

- **Precisa de um modelo.** Sem modelo, nada é gerado. A primeira execução baixa um, de 1,1 a 4,7 GB, a não ser que o Ollama ou o LM Studio já esteja rodando ou você aponte para um endpoint com chave.
- **É mais lento do que parece nos vídeos.** A equipe reveza um único modelo, então um trabalho leva minutos, não segundos. Só com a CPU, o modelo escreve poucos tokens por segundo.
- **Funciona melhor com você no comando.** Peça uma coisa de cada vez, leia os diffs e aprove os passos. Apps grandes de uma vez só estão fora do alcance de um modelo pequeno.

<p align="center">
  <img src="../assets/illustrations/hardware.svg" width="900" alt="Três níveis de hardware em potes de mel: sem GPU roda um modelo pequeno devagar, uma GPU de 6 a 8 GB roda o modelo 7B para tarefas pequenas e médias, uma GPU maior ou uma chave encara trabalhos maiores.">
</p>

| Hardware | Modelo que roda | Velocidade | Bom para |
| --- | --- | --- | --- |
| Sem GPU | Qwen2.5-Coder 1.5B, ou 3B com 16 GB de RAM | Lento, poucos tokens por segundo | Tarefas pequenas, de um arquivo. Tenha paciência. |
| GPU de 3,5 a 6 GB | Qwen2.5-Coder 3B | Usável | Tarefas pequenas, componentes, scripts, textos. |
| GPU de 6 a 8 GB | Qwen2.5-Coder 7B | Bom | Tarefas pequenas e médias, com você no comando. |
| GPU maior, ou uma chave | Um modelo maior pelo Ollama, LM Studio ou um endpoint compatível com a OpenAI | Mais rápido | Trabalhos maiores e planos mais longos. |

**Muito bom em:** landing pages, pequenos apps CRUD, scripts, componentes de interface, testes, documentação e textos, corrigir um bug que você descreve.

**Não é bom em:** apps grandes ou complexos de uma vez só, trabalhos longos sem você ler e aprovar os passos, velocidade numa máquina sem GPU, e qualquer coisa sem um modelo.

**Privacidade:** tudo fica na sua máquina. O modo Emprestar só envia prompts e respostas do modelo para um amigo com quem você pareou: nunca arquivos, um pedido por vez, no máximo 20 por minuto. O amigo vê cada pedido e pode parar quando quiser. Não há relay TURN embutido, então duas redes muito restritas podem não conectar.

## Como a equipe trabalha

<p align="center">
  <img src="../assets/illustrations/crew.svg" width="900" alt="Você pede uma landing page para uma padaria. Mel planeja: o Writer escreve os textos, o Designer cuida do layout e dos estilos, o Dev monta a página e o QA roda as verificações e devolve uma correção. Abaixo, um modelo local com fila: Dev agora, Designer em seguida, QA e Writer aguardando.">
</p>

Cada membro da equipe é uma janela na Colmeia, com avatar, indicador de status e chat ao vivo.

- **Mel**, a mestre de obras, transforma o seu pedido num grafo de tarefas e distribui o trabalho.
- **Dev** escreve e edita código no workspace.
- **Designer** cuida do layout e dos estilos.
- **QA** roda verificações e testes e devolve problemas como tarefas de correção.
- **Writer** faz o README, os textos e a documentação.
- **Contrate o seu**: dê a um novo membro uma função, uma cor de avatar e uma lista de ferramentas permitidas.

Ninguém usa o modelo ao mesmo tempo: um modelo compartilhado, um agendador justo de turnos e uma fila visível. As ferramentas só alcançam a pasta do workspace (listar, ler, escrever, editar, executar e pré-visualizar); comandos rodam com tempo limite, limite de saída e sem rede por padrão. Toda escrita aparece como diff, e o modo de aprovação, ligado por padrão, faz os passos arriscados esperarem o seu sim. Trabalhos que terminam bem viram playbooks que a Mel reaproveita, e todo evento vai para um log que você pode reproduzir.

## Empreste seu PC

<p align="center">
  <img src="../assets/illustrations/lend.svg" width="900" alt="O seu PC roda a Colmeia e guarda os arquivos. O PC de um amigo roda npx hivedesk --lend e mostra seis palavras, um log de pedidos e um botão para parar de emprestar. Entre eles, um link ponto a ponto criptografado leva só os prompts e as respostas do modelo.">
</p>

Um amigo com uma GPU melhor pode emprestar o modelo dele para você:

1. O amigo roda `npx hivedesk --lend` e recebe seis palavras, um QR code e um link.
2. Você digita as palavras em **Use a friend's PC** (ou abre o link). Os dois navegadores pareiam por WebRTC e mostram as mesmas palavras de confirmação.
3. A sua equipe manda os turnos do modelo para a máquina do amigo. O amigo vê cada pedido num log e pode parar de emprestar quando quiser.

Só viajam prompts e respostas. Os arquivos do amigo nunca são lidos nem escritos, e os seus nunca saem da sua máquina. O empréstimo aceita um pedido por vez, no máximo 20 pedidos por minuto e prompts de até 120.000 caracteres. As palavras valem uma vez só e expiram em 10 minutos. O pareamento passa por relays MQTT públicos que só veem um tópico aleatório e texto cifrado. Não há relay TURN embutido, então duas redes muito restritas podem não conectar.

## Privacidade

- O servidor escuta só em `127.0.0.1` e confere um token secreto em cada pedido.
- Sem conta e sem analytics. A rede é usada no download da primeira execução, no modo Emprestar e num endpoint remoto só se você escolher um.
- Tudo fica em arquivos simples que são seus: `.hivedesk/` na sua pasta (`events.jsonl`, `state.json`, `playbooks/`, `workspace/`) e o cache em `~/.hivedesk/`.

Para remover o hivedesk, apague `~/.hivedesk/` e a pasta `.hivedesk/` do seu projeto.

## Perguntas frequentes

**Preciso de conta ou chave de API?** Não. A chave é opcional, só para usar um endpoint compatível com a OpenAI.

**Dá para testar sem baixar um modelo?** Sim: `npx hivedesk --demo` reproduz um trabalho roteirizado, marcado como demo.

**Posso usar um modelo que já tenho?** Sim: o Ollama e o LM Studio são detectados quando estão rodando, ou use `--model` com um arquivo GGUF.

**Por que um trabalho leva minutos?** A equipe inteira divide um modelo e reveza os turnos. A fila aparece na tela.

**Um agente pode estragar o meu computador?** As ferramentas ficam presas à pasta do workspace, caminhos que tentam escapar são recusados, comandos têm tempo limite e rodam sem rede por padrão, e o modo de aprovação faz os passos arriscados esperarem você.

## Documentação

- [FIRST-RUN.md](../FIRST-RUN.md): o que a primeira execução faz, passo a passo, e o que acontece quando algo falha.
- [PROTOCOL.md](../PROTOCOL.md): o contrato entre o motor, a interface e o modo Emprestar.

## Contribuindo

Issues e pull requests são bem-vindos. Veja o [CONTRIBUTING.md](../CONTRIBUTING.md), o [CHANGELOG](../CHANGELOG.md) e a [política de segurança](../SECURITY.md).

## Mais de kwy404

[Monsoon](https://kwy404.github.io/monsoon/) (o CSS da Colmeia e do site), [Voodoo.js](https://kwy404.github.io/Voodoo.js/) (as partes interativas), [kastor](https://kwy404.github.io/kastor/), [fontsketch](https://kwy404.github.io/fontsketch/), [filefinch](https://kwy404.github.io/filefinch/), [howlden](https://kwy404.github.io/howlden/), [installkite](https://kwy404.github.io/installkite/), [a11ymedic](https://kwy404.github.io/a11ymedic/) e [cookieowl](https://kwy404.github.io/cookieowl/).

## Licença

[MIT](../LICENSE). Feito por Alexandre Kohler ([GitHub](https://github.com/kwy404), [LinkedIn](https://www.linkedin.com/in/alexandre-silva-173687256/)).
