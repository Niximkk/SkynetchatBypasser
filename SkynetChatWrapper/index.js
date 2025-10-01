const https = require('https');
const EventEmitter = require('events');

class SkynetChatWrapper extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.history = [];
    this.currentAccount = null;
    this.messageCount = 0;
    this.maxMessagesPerAccount = options.maxMessagesPerAccount || 5;
    this.autoRotate = options.autoRotate !== false;
  }

  generateId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 16; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  _request(options, data = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        
        res.on('data', chunk => {
          body += chunk.toString();
        });

        res.on('end', () => {
          const cookies = {};
          const setCookie = res.headers['set-cookie'];
          
          if (setCookie) {
            setCookie.forEach(cookie => {
              const parts = cookie.split(';')[0].split('=');
              cookies[parts[0]] = parts[1];
            });
          }
          
          resolve({ 
            body, 
            cookies, 
            headers: res.headers,
            statusCode: res.statusCode 
          });
        });
      });

      req.on('error', reject);
      
      if (data) {
        req.write(data);
      }
      
      req.end();
    });
  }

  async createAccount() {
    this.emit('account:creating');
    
    try {
      const codeRes = await this._request({
        hostname: 'skynetchat.net',
        path: '/api/access-code',
        method: 'POST',
        headers: {
          'Accept': '*/*',
          'Origin': 'https://skynetchat.net',
          'Referer': 'https://skynetchat.net/sign-up',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (codeRes.statusCode !== 200) {
        throw new Error(`Failed to generate access code: ${codeRes.statusCode}`);
      }

      const codeData = JSON.parse(codeRes.body);
      const code = codeData.code;
      const cookies = codeRes.cookies;
      
      this.emit('account:code-generated', { code });

      const loginRes = await this._request({
        hostname: 'skynetchat.net',
        path: '/login',
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://skynetchat.net',
          'Referer': 'https://skynetchat.net/login',
          'Cookie': `sid=${cookies.sid}; acc_count=${cookies.acc_count}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, `code=${code}`);

      if (loginRes.statusCode !== 200) {
        throw new Error(`Failed to login: ${loginRes.statusCode}`);
      }

      const newCookies = loginRes.cookies;
      
      this.currentAccount = {
        sid: newCookies.sid,
        acc_count: cookies.acc_count,
        code: code,
        createdAt: new Date().toISOString()
      };

      this.emit('account:created', this.currentAccount);
      return this.currentAccount;

    } catch (error) {
      this.emit('account:error', error);
      throw error;
    }
  }

  async _rotateAccountIfNeeded() {
    if (!this.autoRotate) {
      return;
    }

    if (!this.currentAccount || this.messageCount >= this.maxMessagesPerAccount) {
      this.emit('account:rotating', {
        oldAccount: this.currentAccount,
        messageCount: this.messageCount
      });
      
      await this.createAccount();
      this.messageCount = 0;
      
      this.emit('account:rotated');
    }
  }

  async sendMessage(userMessage) {
    await this._rotateAccountIfNeeded();

    const userId = this.generateId();
    const assistantId = this.generateId();
    const chatId = this.generateId();

    const userMsg = {
      id: userId,
      role: 'user',
      parts: [{
        type: 'text',
        text: userMessage
      }]
    };
    
    this.history.push(userMsg);
    this.emit('message:sent', userMsg);

    const payload = {
      id: chatId,
      messages: [...this.history],
      trigger: 'submit-message'
    };

    this.emit('message:requesting', {
      messageCount: this.messageCount + 1,
      maxMessages: this.maxMessagesPerAccount
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'skynetchat.net',
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Origin': 'https://skynetchat.net',
          'Referer': 'https://skynetchat.net/',
          'Cookie': `sid=${this.currentAccount.sid}; acc_count=${this.currentAccount.acc_count}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, (res) => {
        let fullResponse = '';
        let currentTextId = null;
        
        this.emit('message:receiving');

        res.on('data', chunk => {
          const lines = chunk.toString().split('\n');
          
          lines.forEach(line => {
            if (!line.startsWith('data: ')) return;
            
            const data = line.substring(6);
            if (data === '[DONE]') return;
            
            try {
              const json = JSON.parse(data);
              
              switch (json.type) {
                case 'start':
                  this.emit('stream:start');
                  break;
                  
                case 'start-step':
                  this.emit('stream:step-start');
                  break;
                  
                case 'text-start':
                  currentTextId = json.id;
                  this.emit('stream:text-start', { id: json.id });
                  break;
                  
                case 'text-delta':
                  fullResponse += json.delta;
                  this.emit('stream:text-delta', { 
                    id: json.id, 
                    delta: json.delta,
                    fullText: fullResponse
                  });
                  break;
                  
                case 'text-end':
                  this.emit('stream:text-end', { id: json.id });
                  break;
                  
                case 'finish-step':
                  this.emit('stream:step-finish');
                  break;
                  
                case 'finish':
                  this.emit('stream:finish');
                  break;
              }
            } catch (e) {
            }
          });
        });

        res.on('end', () => {
          const assistantMsg = {
            id: assistantId,
            role: 'assistant',
            parts: [
              { type: 'step-start' },
              {
                type: 'text',
                text: fullResponse,
                state: 'done'
              }
            ]
          };
          
          this.history.push(assistantMsg);
          this.messageCount++;

          this.emit('message:received', {
            message: assistantMsg,
            fullText: fullResponse,
            messageCount: this.messageCount
          });

          resolve(fullResponse);
        });

        res.on('error', (error) => {
          this.emit('message:error', error);
          reject(error);
        });
      });

      req.on('error', (error) => {
        this.emit('message:error', error);
        reject(error);
      });

      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  clearHistory() {
    const oldHistory = [...this.history];
    this.history = [];
    this.messageCount = 0;
    
    this.emit('history:cleared', { 
      previousLength: oldHistory.length 
    });
  }

  getHistory() {
    return [...this.history];
  }

  loadHistory(history, messageCount = 0) {
    this.history = Array.isArray(history) ? [...history] : [];
    this.messageCount = messageCount;
    
    this.emit('history:loaded', { 
      messageCount: this.history.length,
      currentCount: this.messageCount
    });
  }

  getState() {
    return {
      hasAccount: !!this.currentAccount,
      account: this.currentAccount ? {
        code: this.currentAccount.code,
        createdAt: this.currentAccount.createdAt
      } : null,
      messageCount: this.messageCount,
      maxMessagesPerAccount: this.maxMessagesPerAccount,
      historyLength: this.history.length,
      autoRotate: this.autoRotate
    };
  }

  setAutoRotate(enabled) {
    this.autoRotate = !!enabled;
    this.emit('config:auto-rotate-changed', { enabled: this.autoRotate });
  }

  setMaxMessagesPerAccount(max) {
    if (max < 1) {
      throw new Error('Max messages per account must be at least 1');
    }
    
    this.maxMessagesPerAccount = max;
    this.emit('config:max-messages-changed', { max });
  }
}

module.exports = SkynetChatWrapper;