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

  socket.on('finished', () => {
    playing = false;
    playNext();
  });

  // 動画追加時にユニークIDを生成し、追加者のsocket.idも保持する
  socket.on('addVideo', (url) => {
    const videoId = extractVideoId(url);
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2);

    queue.push({
      id: uniqueId,
      name: socket.clientName || '名無し',
      videoId,
      ownerSocketId: socket.id // 追加者の識別用
    });
    console.log(`動画追加: ${videoId} (送信者: ${socket.clientName}, id: ${uniqueId})`);
    broadcastQueue();

    if (!playing && hostSocket) {
      playNext();
    }
  });

  // 削除リクエストを受け取った時
  socket.on('removeVideo', (id) => {
    // キューからidが一致する要素を検索
    const index = queue.findIndex(item => item.id === id);
    if (index !== -1) {
      // 削除リクエスト送信者が追加者と同じかチェック
      if (queue[index].ownerSocketId === socket.id) {
        queue.splice(index, 1);
        console.log(`動画削除: id=${id}`);
        broadcastQueue();
      } else {
        console.log(`削除拒否: id=${id}, socket.id=${socket.id} は追加者ではない`);
        // 必要に応じて拒否通知を送る
        socket.emit('removeDenied', id);
      }
    }
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
