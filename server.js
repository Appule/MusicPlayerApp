const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const SAVES_DIR = path.join(__dirname, 'public', 'saves');
if (!fs.existsSync(SAVES_DIR)) {
  fs.mkdirSync(SAVES_DIR);
}

const HOST_SAVE_FILE = path.join(SAVES_DIR, 'host.json');
// 履歴ファイル読み込み（存在しなければ空配列）
function loadHostHistory() {
  if (!fs.existsSync(HOST_SAVE_FILE)) return [];
  return JSON.parse(fs.readFileSync(HOST_SAVE_FILE, 'utf8'));
}

// 履歴ファイル保存
function saveHostHistory(list) {
  fs.writeFileSync(HOST_SAVE_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function getSaveFile(username) {
  return path.join(SAVES_DIR, `${username}.json`);
}

function loadUserSaves(username) {
  const file = getSaveFile(username);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveUserSaves(username, saves) {
  fs.writeFileSync(getSaveFile(username), JSON.stringify(saves, null, 2), 'utf8');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let queue = [];
let playing = false;
let hostSocket = null;
let currentVideo = null; // ★現在再生中の動画情報

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
  io.emit('queueUpdate', { 
    currentVideo, // 再生中の曲
    queue         // 次に再生される曲一覧
  });
}

io.on('connection', (socket) => {
  console.log('クライアント接続');

  // 名前登録受信
  socket.on('registerName', (name) => {
    socket.clientName = name || '名無し';
    console.log(`クライアント名登録: ${socket.clientName}`);
    // キュー情報を送る（更新は名前付きで）
    socket.emit('queueUpdate', { currentVideo, queue });
  });

  socket.on('registerHost', () => {
    hostSocket = socket;
    console.log('ホスト登録');
    socket.emit('queueUpdate', { currentVideo, queue });
  });
  
  let username = null;
  socket.on('setUsername', (name) => {
    username = name;
    const saves = loadUserSaves(username);
    socket.emit('savedList', saves);
  });

  socket.on('saveVideoId', ({ videoId, name }) => {
    if (!username) return;
    const saves = loadUserSaves(username);
    if (!saves.find(s => s.videoId === videoId)) {
      saves.push({ videoId, name });
      saveUserSaves(username, saves);
      socket.emit('savedList', saves);
    }
  });

  socket.on('deleteSaved', (videoId) => {
    if (!username) return;
    let saves = loadUserSaves(username);
    saves = saves.filter(s => s.videoId !== videoId);
    saveUserSaves(username, saves);
    socket.emit('savedList', saves);
  });

  socket.on('updateSavedName', ({ videoId, newName }) => {
    if (!username) return;
    let saves = loadUserSaves(username);
    const target = saves.find(s => s.videoId === videoId);
    if (target) target.name = newName;
    saveUserSaves(username, saves);
    socket.emit('savedList', saves);
  });

  socket.on('finished', () => {
    playing = false;
    currentVideo = null; // 再生中データをリセット
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

  // ★スキップ要求
  socket.on('skipCurrent', () => {
    if (!currentVideo) {
      socket.emit('skipDenied');
      return;
    }

    // 履歴曲なら誰でもOK
    if (currentVideo.isHistory) {
      console.log(`履歴曲スキップ許可: ${currentVideo.videoId}`);
      playNext();
      return;
    }

    if (currentVideo && currentVideo.ownerSocketId === socket.id) {
      console.log(`スキップ許可: ${currentVideo.videoId} by ${socket.clientName}`);
      playNext();
    } else {
      console.log(`スキップ拒否: 権限なし (${socket.clientName})`);
      socket.emit('skipDenied');
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
      const nextItem = queue.shift();
      currentVideo = nextItem; // ★再生中の動画情報を保存
      playing = true;

      // 履歴に追加（重複なし）
      let history = loadHostHistory();
      if (!history.find(h => h.videoId === nextItem.videoId)) {
        history.push({ videoId: nextItem.videoId, name: nextItem.name });
        saveHostHistory(history);
      }

      hostSocket.emit('playVideo', nextItem.videoId);
      broadcastQueue();
    } else {
      // キューが空の場合、履歴からランダム再生を試みる
      const history = loadHostHistory();
      if (history.length === 0) {
        // 履歴も空なら何もしない
        currentVideo = null;
        playing = false;
        broadcastQueue();
        return;
      }

      // ランダムに選ぶ
      const randIndex = Math.floor(Math.random() * history.length);
      const videoId = history[randIndex].videoId;

      // currentVideo に履歴曲情報をセット
      currentVideo = {
        id: `history_${Date.now()}`,  // 履歴再生用ID（適当でOK）
        name: history[randIndex].name || '履歴の曲',
        videoId,
        ownerSocketId: null,  // 履歴曲なので追加者はなし
        isHistory: true       // 履歴曲フラグ
      };
      playing = true;
      hostSocket.emit('playVideo', videoId);
      broadcastQueue();
    }
  }
});

server.listen(3000, () => {
  console.log('listening on *:3000');
});
