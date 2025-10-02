const https = require('https');
const http = require('http');
const EventEmitter = require('events');
const fs = require('fs');

class SkynetChatWrapper extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.history = [];
    this.currentAccount = null;
    this.messageCount = 0;
    this.maxMessagesPerAccount = options.maxMessagesPerAccount || 5;
    this.autoRotate = options.autoRotate !== false;
    
    this.proxies = [];
    this.currentProxyIndex = -1;
    this.proxyFile = options.proxyFile || 'proxies.txt';
    this.autoLoadProxies = options.autoLoadProxies !== false;
    this.blacklistedProxies = new Set();
    this.proxyTimeout = options.proxyTimeout || 10000;
    
    if (this.autoLoadProxies) {
      this.loadProxies();
    }
  }

  loadProxies(filePath) {
    const path = filePath || this.proxyFile;
    
    try {
      if (fs.existsSync(path)) {
        const content = fs.readFileSync(path, 'utf8');
        this.proxies = content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
          .map(line => {
            const parts = line.split(':');
            
            if (parts.length === 4) {
              const [host, port, username, password] = parts;
              return { 
                host, 
                port: parseInt(port),
                username,
                password,
                key: `${host}:${port}`,
                hasAuth: true
              };
            }
            else if (parts.length === 2) {
              const [host, port] = parts;
              return { 
                host, 
                port: parseInt(port), 
                key: `${host}:${port}`,
                hasAuth: false
              };
            }
            
            return null;
          })
          .filter(proxy => proxy && proxy.host && proxy.port);
        
        this.emit('proxy:loaded', { 
          count: this.proxies.length,
          withAuth: this.proxies.filter(p => p.hasAuth).length
        });
        return this.proxies.length;
      } else {
        this.emit('proxy:file-not-found', { path });
        return 0;
      }
    } catch (error) {
      this.emit('proxy:load-error', error);
      return 0;
    }
  }

  addProxy(host, port, username = null, password = null) {
    const key = `${host}:${port}`;
    const proxy = { 
      host, 
      port: parseInt(port), 
      key,
      hasAuth: !!(username && password)
    };
    
    if (username && password) {
      proxy.username = username;
      proxy.password = password;
    }
    
    this.proxies.push(proxy);
    this.emit('proxy:added', { 
      host, 
      port, 
      hasAuth: proxy.hasAuth,
      total: this.proxies.length 
    });
  }

  blacklistProxy(proxy, reason) {
    this.blacklistedProxies.add(proxy.key);
    this.emit('proxy:blacklisted', { 
      proxy: `${proxy.host}:${proxy.port}`, 
      reason,
      totalBlacklisted: this.blacklistedProxies.size
    });
  }

  getNextProxy() {
    if (this.proxies.length === 0) {
      return null;
    }
    
    const availableProxies = this.proxies.filter(p => !this.blacklistedProxies.has(p.key));
    
    if (availableProxies.length === 0) {
      this.emit('proxy:all-blacklisted', { 
        total: this.proxies.length,
        blacklisted: this.blacklistedProxies.size
      });
      return null;
    }
    
    this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
    let proxy = this.proxies[this.currentProxyIndex];
    
    let attempts = 0;
    while (this.blacklistedProxies.has(proxy.key) && attempts < this.proxies.length) {
      this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
      proxy = this.proxies[this.currentProxyIndex];
      attempts++;
    }
    
    if (this.blacklistedProxies.has(proxy.key)) {
      return null;
    }
    
    this.emit('proxy:switched', { 
      index: this.currentProxyIndex, 
      total: this.proxies.length,
      available: availableProxies.length,
      proxy 
    });
    
    return proxy;
  }

  getCurrentProxy() {
    if (this.currentProxyIndex >= 0 && this.currentProxyIndex < this.proxies.length) {
      const proxy = this.proxies[this.currentProxyIndex];
      return this.blacklistedProxies.has(proxy.key) ? null : proxy;
    }
    return null;
  }

  generateId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 16; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  _request(options, data = null, useProxy = true) {
    return new Promise((resolve, reject) => {
      let requestOptions = { ...options };
      let protocol = https;
      let currentProxy = null;
      
      if (useProxy && this.proxies.length > 0) {
        const proxy = this.getCurrentProxy() || this.getNextProxy();
        
        if (proxy) {
          currentProxy = proxy;
          protocol = http;
          
          const headers = {
            ...options.headers,
            Host: options.hostname
          };
          
          if (proxy.hasAuth && proxy.username && proxy.password) {
            const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
            headers['Proxy-Authorization'] = `Basic ${auth}`;
          }
          
          requestOptions = {
            hostname: proxy.host,
            port: proxy.port,
            path: `https://${options.hostname}${options.path}`,
            method: options.method,
            headers,
            timeout: this.proxyTimeout
          };
        }
      }
      
      const req = protocol.request(requestOptions, (res) => {
        let body = '';
        
        if ([301, 302, 307, 308, 403, 407].includes(res.statusCode) && currentProxy) {
          this.blacklistProxy(currentProxy, `HTTP ${res.statusCode}`);
          const error = new Error(`Proxy returned ${res.statusCode}`);
          error.code = 'PROXY_REDIRECT_OR_FORBIDDEN';
          error.statusCode = res.statusCode;
          return reject(error);
        }
        
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

      req.on('timeout', () => {
        req.destroy();
        if (currentProxy) {
          this.blacklistProxy(currentProxy, 'Timeout');
        }
        const error = new Error('Request timeout');
        error.code = 'ETIMEDOUT';
        reject(error);
      });

      req.on('error', (error) => {
        if (currentProxy && (error.code === 'ECONNREFUSED' || 
                             error.code === 'ECONNRESET' || 
                             error.code === 'ETIMEDOUT' ||
                             error.code === 'ENOTFOUND')) {
          this.blacklistProxy(currentProxy, error.code);
        }
        reject(error);
      });
      
      if (data) {
        req.write(data);
      }
      
      req.end();
    });
  }

  async createAccount(retryCount = 0) {
    const maxRetries = Math.min(this.proxies.length - this.blacklistedProxies.size, 20);
    
    if (maxRetries <= 0) {
      throw new Error('Nenhum proxy válido disponível');
    }
    
    this.emit('account:creating', { 
      attempt: retryCount + 1,
      availableProxies: maxRetries
    });
    
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

      if (codeRes.statusCode === 429) {
        this.emit('account:rate-limited', { 
          attempt: retryCount + 1,
          maxRetries 
        });
        
        if (retryCount < maxRetries && this.proxies.length > 0) {
          const currentProxy = this.getCurrentProxy();
          if (currentProxy) {
            this.blacklistProxy(currentProxy, 'Rate limited (429)');
          }
          this.getNextProxy();
          await new Promise(resolve => setTimeout(resolve, 1000));
          return this.createAccount(retryCount + 1);
        } else {
          throw new Error('Rate limited (429) - Todos os proxies foram tentados ou bloqueados');
        }
      }

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
        createdAt: new Date().toISOString(),
        proxy: this.getCurrentProxy()
      };

      this.emit('account:created', this.currentAccount);
      return this.currentAccount;

    } catch (error) {
      if ((error.code === 'PROXY_REDIRECT_OR_FORBIDDEN' || 
           error.code === 'ECONNREFUSED' || 
           error.code === 'ECONNRESET' ||
           error.code === 'ETIMEDOUT') && 
          retryCount < maxRetries) {
        
        this.emit('account:proxy-failed', { 
          error: error.message,
          attempt: retryCount + 1,
          maxRetries
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        return this.createAccount(retryCount + 1);
      }
      
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
      let requestOptions = {
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
        },
        timeout: this.proxyTimeout
      };

      let protocol = https;
      
      if (this.proxies.length > 0 && this.currentAccount.proxy) {
        const proxy = this.currentAccount.proxy;
        protocol = http;
        
        const headers = {
          ...requestOptions.headers,
          Host: 'skynetchat.net'
        };
        
        if (proxy.hasAuth && proxy.username && proxy.password) {
          const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
          headers['Proxy-Authorization'] = `Basic ${auth}`;
        }
        
        requestOptions = {
          hostname: proxy.host,
          port: proxy.port,
          path: `https://skynetchat.net/api/chat`,
          method: 'POST',
          headers,
          timeout: this.proxyTimeout
        };
      }

      const req = protocol.request(requestOptions, (res) => {
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

      req.on('timeout', () => {
        req.destroy();
        const error = new Error('Request timeout');
        error.code = 'ETIMEDOUT';
        this.emit('message:error', error);
        reject(error);
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
        createdAt: this.currentAccount.createdAt,
        proxy: this.currentAccount.proxy
      } : null,
      messageCount: this.messageCount,
      maxMessagesPerAccount: this.maxMessagesPerAccount,
      historyLength: this.history.length,
      autoRotate: this.autoRotate,
      proxies: {
        total: this.proxies.length,
        blacklisted: this.blacklistedProxies.size,
        available: this.proxies.length - this.blacklistedProxies.size,
        current: this.getCurrentProxy()
      }
    };
  }

  clearBlacklist() {
    const count = this.blacklistedProxies.size;
    this.blacklistedProxies.clear();
    this.emit('proxy:blacklist-cleared', { count });
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