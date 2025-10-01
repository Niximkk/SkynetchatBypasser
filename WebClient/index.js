const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const SkynetChatWrapper = require('../SkynetChatWrapper');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR);
}

app.use(express.static('public'));

const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const chat = new SkynetChatWrapper({
      maxMessagesPerAccount: 5,
      autoRotate: true
    });
    
    sessions.set(sessionId, {
      chat,
      lastActivity: Date.now()
    });
    
    console.log(`[SESSION] Created: ${sessionId}`);
  }
  
  sessions.get(sessionId).lastActivity = Date.now();
  return sessions.get(sessionId).chat;
}

function saveSession(sessionId, chat) {
  try {
    const state = chat.getState();
    const data = {
      history: chat.getHistory(),
      messageCount: state.messageCount,
      timestamp: new Date().toISOString()
    };
    
    const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    console.log(`[SESSION] Saved: ${sessionId}`);
  } catch (error) {
    console.error(`[SESSION] Error saving ${sessionId}:`, error.message);
  }
}

function loadSession(sessionId, chat) {
  try {
    const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    
    if (fs.existsSync(filepath)) {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      chat.loadHistory(data.history || [], data.messageCount || 0);
      console.log(`[SESSION] Loaded: ${sessionId}`);
      return true;
    }
  } catch (error) {
    console.error(`[SESSION] Error loading ${sessionId}:`, error.message);
  }
  return false;
}

function cleanupInactiveSessions() {
  const TIMEOUT = 30 * 60 * 1000;
  const now = Date.now();
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > TIMEOUT) {
      saveSession(sessionId, session.chat);
      sessions.delete(sessionId);
      console.log(`[SESSION] Cleaned up: ${sessionId}`);
    }
  }
}

setInterval(cleanupInactiveSessions, 5 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`[CLIENT] Connected: ${socket.id}`);
  
  const sessionId = socket.id;
  const chat = getSession(sessionId);
  
  const setupChatListeners = () => {
    chat.removeAllListeners();
    
    chat.on('account:creating', () => {
      socket.emit('log', { type: 'info', message: 'Creating new account...' });
    });
    
    chat.on('account:created', (account) => {
      socket.emit('log', { type: 'success', message: `Account created: ${account.code}` });
      socket.emit('state', chat.getState());
    });
    
    chat.on('account:rotating', ({ messageCount }) => {
      socket.emit('log', { type: 'info', message: `Rotating account (${messageCount} messages used)` });
    });
    
    chat.on('account:rotated', () => {
      socket.emit('log', { type: 'success', message: 'Account rotated successfully' });
    });
    
    chat.on('message:requesting', ({ messageCount, maxMessages }) => {
      socket.emit('log', { type: 'info', message: `Sending message (${messageCount}/${maxMessages})` });
    });
    
    chat.on('stream:text-delta', ({ delta }) => {
      socket.emit('message:chunk', delta);
    });
    
    chat.on('message:received', ({ fullText, messageCount }) => {
      socket.emit('message:complete', fullText);
      socket.emit('state', chat.getState());
      saveSession(sessionId, chat);
    });
    
    chat.on('message:error', (error) => {
      socket.emit('log', { type: 'error', message: error.message });
      socket.emit('error', error.message);
    });
    
    chat.on('history:cleared', () => {
      socket.emit('log', { type: 'info', message: 'History cleared' });
      socket.emit('state', chat.getState());
    });
  };
  
  setupChatListeners();
  
  socket.on('load-session', () => {
    const loaded = loadSession(sessionId, chat);
    if (loaded) {
      socket.emit('history', chat.getHistory());
      socket.emit('state', chat.getState());
      socket.emit('log', { type: 'success', message: 'Session loaded' });
    }
  });
  
  socket.on('send-message', async (message) => {
    try {
      await chat.sendMessage(message);
    } catch (error) {
      socket.emit('error', error.message);
    }
  });
  
  socket.on('clear-history', () => {
    chat.clearHistory();
    saveSession(sessionId, chat);
  });
  
  socket.on('get-state', () => {
    socket.emit('state', chat.getState());
  });
  
  socket.on('get-history', () => {
    socket.emit('history', chat.getHistory());
  });
  
  socket.on('export-history', () => {
    const history = chat.getHistory();
    socket.emit('export-data', history);
  });
  
  socket.on('force-rotate', async () => {
    try {
      await chat.createAccount();
      chat.messageCount = 0;
      socket.emit('state', chat.getState());
    } catch (error) {
      socket.emit('error', error.message);
    }
  });
  
  socket.on('set-auto-rotate', (enabled) => {
    chat.setAutoRotate(enabled);
    socket.emit('state', chat.getState());
  });
  
  socket.on('set-max-messages', (max) => {
    try {
      chat.setMaxMessagesPerAccount(max);
      socket.emit('state', chat.getState());
    } catch (error) {
      socket.emit('error', error.message);
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`[CLIENT] Disconnected: ${socket.id}`);
    saveSession(sessionId, chat);
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down...');
  for (const [sessionId, session] of sessions.entries()) {
    saveSession(sessionId, session.chat);
  }
  process.exit(0);
});