# Monitor Correios Importador

Monitora automaticamente o Portal **Minhas Importações** dos Correios em uma ou mais contas idCorreios e envia alertas no Telegram quando o status de uma encomenda muda.

Sem dependências externas: só Node.js 18+.

## Configuração

1. Copie `.env.example` para `.env` e preencha:
   - `CORREIOS_ACCOUNTS`: contas no formato `CPF:SENHA`, separadas por vírgula
   - `TELEGRAM_BOT_TOKEN`: token de um bot criado com o [@BotFather](https://t.me/BotFather)
2. Rode `npm start`.
3. Mande qualquer mensagem para o seu bot no Telegram. O primeiro chat que falar com ele vira o dono e passa a receber os alertas.

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm start` | Inicia o monitor em primeiro plano |
| `npm run check-once` | Faz uma única varredura e encerra |
| `npm run install-task` | (Windows) Registra o monitor para iniciar no logon, em segundo plano |
| `npm run uninstall-task` | (Windows) Remove a inicialização automática |
| `npm run stop` | (Windows) Encerra o monitor salvando o estado |

### No Telegram

- `/status`: encomendas ativas e status das contas
- `/consultar`: força uma varredura agora
- `/historico`: histórico de status de cada encomenda
- `/parar`: encerra o monitor

## Arquivos locais

`state.json`, `monitor.log` e `monitor.pid` são gerados em tempo de execução e ficam fora do Git, assim como o `.env`.
