# Como contribuir

Para contribuir com o Varanda, faça um fork, crie uma branch e abra um pull request.

## Por onde começar

Veja as tarefas no [quadro do projeto](https://github.com/orgs/Varanda-org/projects/1).
As fases são organizadas em milestones.

Procure as etiquetas `good first issue` e `help wanted`.
Comente na issue antes de começar, para evitar que duas pessoas façam o mesmo trabalho.

Tire dúvidas em [Discussions](https://github.com/Varanda-org/varanda/discussions).

## Ambiente

Você precisa de Node.js 20 ou superior (`>=20`) e npm.
Instale as dependências na raiz do repositório:

```sh
npm install
```

O monorepo usa npm workspaces e um único `package-lock.json`, na raiz.
Não crie um lockfile dentro de um workspace.

Veja a seção “Estrutura do repositório” do [README](README.md).
Para compilar o app, siga as seções “iOS” e “Android” de [docs/development.md](docs/development.md).

## Antes de abrir o PR

Execute na raiz, nesta ordem:

```sh
npm ci
npm run lint
npm test
npm run demo
```

O `npm ci` é opcional localmente; ele apaga `node_modules` e reinstala tudo conforme o `package-lock.json`.
O lint usa `standard`. Os testes usam `brittle` nos workspaces que têm testes.
A demo deve terminar imprimindo `DEMO OK`.

A CI executa esses mesmos quatro passos, nessa ordem, nas versões 20 e 24 do Node em cada pull request.

## Convenções

Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:` ou `ci:`.
Escreva em inglês, como o resto do histórico, em minúsculas, no imperativo e sem ponto final. O título do PR segue o mesmo formato. Exemplos:

```text
feat: add a filter to the feed
fix: release closed sockets from quarantine fetches
docs: explain the installation
```

Nomeie a branch como `<tipo>/<slug>`, por exemplo `fix/fetch-socket-retention`.

Toda dependência deve ter versão exata, sem `^`, `~` ou intervalos.
Na raiz, troque `<nome>`, `<versão>` e `<workspace>` pelos valores reais (por exemplo, `-w packages/core`):

```sh
npm install --save-exact <nome>@<versão> -w <workspace>
```

Escreva em pt-BR todo texto que a pessoa usuária vê, inclusive as saídas da CLI e as telas do app.

[docs/protocol.md](docs/protocol.md) e [docs/rpc.md](docs/rpc.md) são normativos.
Se código e documento divergem, um dos dois está errado.
Mudanças em formatos, mensagens ou métodos devem atualizar o documento correspondente no mesmo PR.

## Pull requests

Abra o PR a partir do seu fork, com destino à branch `main` do repositório do Varanda.

- Trate um assunto por PR.
- Descreva o que mudou e por quê.
- Referencie a issue com `Closes #n`, substituindo `n` pelo número.
- Espere a CI passar antes do merge.
- Aguarde a revisão de @Varanda-org/mantenedores, equipe responsável pelos arquivos no CODEOWNERS.

Os mantenedores fazem o merge. Quem contribui nunca envia alterações diretamente para `main`.

## Trabalho fora do código

Os mantenedores coordenam o trabalho jurídico, de parcerias, de moderação e com fornecedores de verificação de idade.
As etiquetas dessas áreas são `área:jurídico`, `área:parceiros` e `área:moderação`.

Ofereça ajuda na issue correspondente ou em [Discussions](https://github.com/Varanda-org/varanda/discussions).

## Quem ajuda com frequência

Quem contribui regularmente pode receber um convite para ajudar na triagem de etiquetas, issues e tarefas do quadro.
Com o tempo, pode receber um convite para a equipe de mantenedores.

## Segurança

Nunca relate uma vulnerabilidade em uma issue pública.
Siga o canal privado descrito em [SECURITY.md](SECURITY.md).

## Conduta

Ao participar, siga o [Código de Conduta](CODE_OF_CONDUCT.md).

## Licença

As contribuições são aceitas sob a mesma [licença MIT do repositório](LICENSE).
A licença de entrada é a mesma de saída (“inbound = outbound”).
Ao abrir um PR, você concorda com esses termos.
