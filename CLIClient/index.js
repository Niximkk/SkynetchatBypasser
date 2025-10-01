const readline = require('readline');
const SkynetChatWrapper = require('../SkynetChatWrapper');
const fs = require('fs');
const path = require('path');

class SkynetClient {
  constructor() {
    this.chat = new SkynetChatWrapper({
      maxMessagesPerAccount: 5,
      autoRotate: true
    });
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    this.historyFile = path.join(__dirname, 'chat_history.json');
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.chat.on('account:creating', () => {
      console.log('Criando nova conta...');
    });

    this.chat.on('account:code-generated', ({ code }) => {
      console.log(`Código gerado: ${code}`);
    });

    this.chat.on('account:created', (account) => {
      console.log('Conta criada com sucesso!');
    });

    this.chat.on('account:rotating', ({ messageCount }) => {
      console.log(`\nRotacionando conta (${messageCount} mensagens usadas)...`);
    });

    this.chat.on('account:rotated', () => {
      console.log('Conta rotacionada!');
    });

    this.chat.on('account:error', (error) => {
      console.error('Erro ao criar conta:', error.message);
    });

    this.chat.on('message:requesting', ({ messageCount, maxMessages }) => {
      console.log(`\nEnviando mensagem (${messageCount}/${maxMessages})...\n`);
    });

    this.chat.on('message:receiving', () => {
      process.stdout.write('🤖 Skynet: ');
    });

    this.chat.on('stream:text-delta', ({ delta }) => {
      process.stdout.write(delta);
    });

    this.chat.on('stream:finish', () => {
      console.log('\n');
    });

    this.chat.on('message:received', () => {
      this.saveHistory();
    });

    this.chat.on('message:error', (error) => {
      console.error('\nErro ao enviar mensagem:', error.message);
    });

    this.chat.on('history:cleared', ({ previousLength }) => {
      console.log(`🗑️ Histórico limpo! (${previousLength} mensagens removidas)`);
    });

    this.chat.on('history:loaded', ({ messageCount, currentCount }) => {
      console.log(`📂 Histórico carregado! (${messageCount} mensagens, contador: ${currentCount})`);
    });

    // Eventos de configuração
    this.chat.on('config:auto-rotate-changed', ({ enabled }) => {
      console.log(`⚙️ Auto-rotação ${enabled ? 'ativada' : 'desativada'}`);
    });

    this.chat.on('config:max-messages-changed', ({ max }) => {
      console.log(`⚙️ Máximo de mensagens por conta alterado para ${max}`);
    });
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf8');
        const saved = JSON.parse(data);
        
        this.chat.loadHistory(saved.history || [], saved.messageCount || 0);
        return true;
      }
    } catch (error) {
      console.log('⚠️ Erro ao carregar histórico:', error.message);
    }
    return false;
  }

  saveHistory() {
    try {
      const state = this.chat.getState();
      const data = {
        history: this.chat.getHistory(),
        messageCount: state.messageCount,
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(this.historyFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.log('⚠️ Erro ao salvar histórico:', error.message);
    }
  }

  showBanner() {
    console.clear();
    console.log('⢎⡑ ⡇⡠ ⡀⢀ ⣀⡀ ⢀⡀ ⣰⡀ ⣏⡱ ⡀⢀ ⣀⡀ ⢀⣀ ⢀⣀ ⢀⣀ ⢀⡀ ⡀⣀');
    console.log('⠢⠜ ⠏⠢ ⣑⡺ ⠇⠸ ⠣⠭ ⠘⠤ ⠧⠜ ⣑⡺ ⡧⠜ ⠣⠼ ⠭⠕ ⠭⠕ ⠣⠭ ⠏ ');
    console.log('v1.0\n');
  }

  showHelp() {
    console.log('\n📋 Comandos disponíveis:');
    console.log('  /help       - Mostra esta ajuda');
    console.log('  /clear      - Limpa o histórico da conversa');
    console.log('  /save       - Salva a conversa atual');
    console.log('  /load       - Carrega conversa salva');
    console.log('  /history    - Mostra histórico da conversa');
    console.log('  /status     - Mostra status da conta atual');
    console.log('  /rotate     - Força rotação de conta');
    console.log('  /autorotate - Liga/desliga rotação automática');
    console.log('  /setmax <n> - Define max de mensagens por conta');
    console.log('  /export     - Exporta conversa para markdown');
    console.log('  /exit       - Sai do programa\n');
  }

  showHistory() {
    const history = this.chat.getHistory();
    
    if (history.length === 0) {
      console.log('\n📭 Histórico vazio!\n');
      return;
    }

    console.log('\n📜 Histórico da conversa:\n');
    history.forEach((msg, index) => {
      const role = msg.role === 'user' ? '👤 Você' : '🤖 Skynet';
      const text = msg.parts.find(p => p.type === 'text')?.text || '[sem texto]';
      const preview = text.length > 80 ? text.substring(0, 80) + '...' : text;
      console.log(`${index + 1}. ${role}: ${preview}`);
    });
    console.log('');
  }

  showStatus() {
    const state = this.chat.getState();
    
    console.log('\n📊 Status:');
    console.log(`  Mensagens enviadas: ${state.messageCount}/${state.maxMessagesPerAccount}`);
    console.log(`  Histórico: ${state.historyLength} mensagens`);
    console.log(`  Auto-rotação: ${state.autoRotate ? '✅ Ativa' : '❌ Desativada'}`);
    console.log(`  Conta atual: ${state.hasAccount ? '✅ Ativa' : '❌ Nenhuma'}`);
    
    if (state.account) {
      console.log(`  Código da conta: ${state.account.code}`);
      console.log(`  Criada em: ${new Date(state.account.createdAt).toLocaleString('pt-BR')}`);
    }
    console.log('');
  }

  exportToMarkdown() {
    const history = this.chat.getHistory();
    
    if (history.length === 0) {
      console.log('\n❌ Histórico vazio, nada para exportar!\n');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const filename = `chat_export_${timestamp}.md`;
    
    let markdown = `# Conversa SkynetChat\n\n`;
    markdown += `**Data:** ${new Date().toLocaleString('pt-BR')}\n\n`;
    markdown += `---\n\n`;
    
    history.forEach((msg, index) => {
      const role = msg.role === 'user' ? '**Você**' : '**Skynet**';
      const text = msg.parts.find(p => p.type === 'text')?.text || '[sem texto]';
      markdown += `### ${role}\n\n${text}\n\n`;
    });
    
    fs.writeFileSync(filename, markdown);
    console.log(`\n📄 Conversa exportada para: ${filename}\n`);
  }

  async handleCommand(input) {
    const parts = input.trim().split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case '/help':
        this.showHelp();
        return true;

      case '/clear':
        this.chat.clearHistory();
        return true;

      case '/save':
        this.saveHistory();
        console.log('💾 Conversa salva!\n');
        return true;

      case '/load':
        if (this.loadHistory()) {
          console.log('✅ Conversa carregada!\n');
        } else {
          console.log('❌ Nenhuma conversa salva encontrada.\n');
        }
        return true;

      case '/history':
        this.showHistory();
        return true;

      case '/status':
        this.showStatus();
        return true;

      case '/rotate':
        console.log('🔄 Forçando rotação de conta...\n');
        await this.chat.createAccount();
        this.chat.messageCount = 0;
        return true;

      case '/autorotate':
        const currentState = this.chat.getState();
        this.chat.setAutoRotate(!currentState.autoRotate);
        return true;

      case '/setmax':
        if (args.length === 0 || isNaN(args[0])) {
          console.log('❌ Uso: /setmax <número>\n');
          return true;
        }
        try {
          this.chat.setMaxMessagesPerAccount(parseInt(args[0]));
        } catch (error) {
          console.log(`❌ Erro: ${error.message}\n`);
        }
        return true;

      case '/export':
        this.exportToMarkdown();
        return true;

      case '/exit':
        console.log('\n👋 Até logo!\n');
        this.rl.close();
        process.exit(0);
        return true;

      default:
        console.log(`❌ Comando desconhecido: ${command}`);
        console.log('💡 Digite /help para ver os comandos disponíveis\n');
        return true;
    }
  }

  async askQuestion(prompt) {
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }

  async start() {
    this.showBanner();
    console.log('💡 Digite /help para ver os comandos disponíveis\n');
    console.log('─'.repeat(50));

    if (fs.existsSync(this.historyFile)) {
      const load = await this.askQuestion('\n📂 Histórico encontrado! Deseja carregar? (s/n): ');
      if (load.toLowerCase() === 's' || load.toLowerCase() === 'sim') {
        this.loadHistory();
      }
      console.log('');
    }

    while (true) {
      try {
        const input = await this.askQuestion('👤 Você: ');

        if (!input.trim()) {
          continue;
        }

        if (input.startsWith('/')) {
          await this.handleCommand(input);
          continue;
        }

        await this.chat.sendMessage(input);

      } catch (error) {
        console.error('❌ Erro:', error.message);
        console.log('🔄 Tentando novamente...\n');
      }
    }
  }
}

if (require.main === module) {
  const client = new SkynetClient();
  client.start().catch(error => {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  });
}

module.exports = SkynetClient;