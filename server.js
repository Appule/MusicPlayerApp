const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let queue = [];
let playing = false;
let hostSocket = null;

// 強化版 動画ID抽出
function extractVideoId(url) {
  try {
    // URLとして解釈
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      // 短縮URL → パスの最初の部分がID
      return u.pathname.slice(1);
    }
    if (u.searchParams.has('v')) {
      return u.searchParams.get('v');
    }
    // /embed/VIDEOID 型
    const embedMatch = u.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) {
      return embedMatch[1];
    }
  } catch (e) {
    // URLでない場合はそのままID扱い
    return url;
  }
  return url;
}

// 追加：クライアント全員にキューの状態を送る関数
function broadcastQueue() {
  io.emit('queueUpdate', queue);
}

io.on('connection', (socket) => {
  console.log('クライアント接続');

  // 名前登録受信
  socket.on('registerName', (name) => {
    socket.clientName = name || '名無し';
    console.log(`クライアント名登録: ${socket.clientName}`);
    // キュー情報を送る（更新は名前付きで）
    socket.emit('queueUpdate', queue);
  });

  socket.on('registerHost', () => {
    hostSocket = socket;
    console.log('ホスト登録');
    socket.emit('queueUpdate', queue);
  });

  socket.on('addVideo', (url) => {
    const videoId = extractVideoId(url);
    // 名前と動画IDをオブジェクトでキューに保存
    queue.push({ name: socket.clientName || '名無し', videoId });
    console.log(`動画ID追加: ${videoId} (送信者: ${socket.clientName})`);
    broadcastQueue();
    if (!playing && hostSocket) {
      playNext();
    }
  });

  socket.on('finished', () => {
    playing = false;
    playNext();
  });

  function playNext() {
    if (queue.length > 0 && hostSocket) {
      const nextItem = queue.shift(); // {name, videoId}
      playing = true;
      hostSocket.emit('playVideo', nextItem.videoId);
      broadcastQueue();
    }
  }
});

server.listen(3000, () => {
  console.log('listening on *:3000');
});
