# O aplicativo Varanda

O app é a interface do Varanda para iOS, Android e web. Ele não guarda lógica de protocolo: fala com um nó pelo contrato de [rpc.md](rpc.md). A interface ainda está em construção. Onde este documento diz "em construção", a tela pode mudar de campos ou de ordem.

## O que o app faz hoje

- Cria a identidade (a chave pública do diário) e mostra o estado do certificado de membro.
- Publica textos e respostas no diário da pessoa, e define nome e bio.
- Segue e deixa de seguir chaves públicas.
- Mostra o feed dos diários seguidos e o diário da própria pessoa.
- Sincroniza com pares e com o semeador, uma vez ou de modo contínuo.

Os formatos de registro e de certificado estão em [protocol.md](protocol.md). Os nomes das partes do app (A Rua, Diário e os demais) vêm de [design.md](design.md).

## Onde o nó roda

Há dois jeitos de ter um nó, e a interface é a mesma:

- **No aplicativo (iOS, Android).** O nó é a sessão do `@varanda/core` rodando num worklet Bare dentro do app. A interface fala com ele por IPC, sem token: o canal é privado do processo do app. Os dados ficam no diretório de documentos do app, na pasta `varanda`. A prova no simulador iOS está em [ios-gate.md](ios-gate.md). Android ainda não foi verificado em execução nativa.
- **Na web, com o `varanda-serve`.** O navegador não roda o nó. Quem roda é o `varanda-serve`, na máquina da pessoa, e a interface fala com ele por um WebSocket em `127.0.0.1`. As chaves ficam na máquina, não no navegador. As opções e as regras de segurança do servidor estão no [README](../README.md) (seção "Servidor local para a interface web").

## Primeira configuração

### No app nativo: tela Conectar

Só o app nativo tem essa tela. Ela pede:

- a chave pública da associação (64 dígitos hexadecimais);
- como achar pares: uma lista de bootstrap (`host:porta`) ou o interruptor "DHT pública", que começa desligado;
- opcionalmente, o endereço local da DHT.

A DHT pública é uma escolha ativa da pessoa (opt-in). Sem bootstrap e sem o interruptor ligado, o nó não tem como achar pares. A configuração que não é segredo fica no diretório de documentos do app.

### Na web: sem onboarding

A web não tem essa etapa. A associação, o bootstrap e a DHT vêm das opções do `varanda-serve`. O token chega no fragmento da URL (`#token=...`) que o `varanda-serve` imprime. O app o lê, o guarda só em memória e o envia em `session.open`. O navegador não envia o fragmento ao servidor.

## Telas

Em construção: os nomes estão fixos, os detalhes visuais não.

- **Identidade.** Cria a identidade e mostra a chave pública e o estado do certificado de membro. Aceita colar o JSON do certificado emitido pela associação.
- **Perfil.** Nome (1 a 80 caracteres) e bio (0 a 280).
- **Publicar.** Escreve uma publicação (1 a 1000 caracteres). Também responde a uma publicação a partir de A Rua.
- **Seguindo.** Segue ou deixa de seguir por chave pública. A lista é paginada.
- **A Rua.** O feed. "Carregar mais" traz mais publicações até o máximo da página do contrato (`FEED_LIMIT_MAX`, em [rpc.md](rpc.md)). Por ora A Rua mostra só os diários seguidos; trazer quem a pessoa não segue é uma mudança de desenho descrita em [design.md](design.md).
- **Diário.** O diário da própria pessoa, bloco a bloco. Blocos inválidos aparecem marcados.
- **Sincronizar.** Sincroniza uma vez ou de modo contínuo, para a sincronização e mostra as linhas de evento.

Só um nó usa um diretório de dados por vez: um segundo worklet no mesmo diretório recebe `LOCKED`. Todo texto vindo de outros pares passa por `displayText`, do `@varanda/rpc`, antes de aparecer.

## Fora do piloto

- **Cadeiras de Praia:** conversas em grupo e salas de áudio. Pedem diário com vários autores e transmissão em tempo real.
- **Espiadinha:** a aba de descobrir. Pede a cidade ou o estado de quem publica.
- **Selo Gente da Gente:** pede critério para "construtivo" e quem concede.

Os pontos em aberto de cada um estão em [design.md](design.md).
