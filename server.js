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

// ユーザーの待ち時間
const waitTimes = {};
const userQueues = {}; // userId => [動画オブジェクト]
const socketIdToUserId = {};
let currentTrack = null;
let playing = false;
let hostSocket = null;
let trackStartTime = null;

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
function broadcastAllQueues() {
  // クライアントには、
  // currentTrack と userQueues の形で送信
  io.emit('queueUpdate', {
    currentTrack,
    userQueues
  });
}

io.on('connection', (socket) => {
  console.log(`新しい接続: socket.id=${socket.id}`);

  // 名前登録受信
  let userId, username;
  socket.on('registerUserParams', ({ id, name }) => {
    userId = id;
    username = name;
    socketIdToUserId[socket.id] = userId;
    
    const saves = loadUserSaves(username);
    socket.emit('savedList', saves);
    
    // 新規を初期化
    if (!waitTimes[userId]) {
      waitTimes[userId] = { userId, username, time: 0 };
    } else {
      waitTimes[userId].username = username; // ユーザー名の更新
    }
    if (!userQueues[userId]) userQueues[userId] = [];

    // クライアントへ現在の状態を送る
    console.log(`ユーザー登録: ${userId} (socket.id=${socket.id})`);
    socket.emit('queueUpdate', { currentTrack, userQueues });
  });

  socket.on('disconnect', () => {
    console.log(`切断: socket.id=${socket.id} userId=${userId}`);
    delete socketIdToUserId[socket.id];
  });

  socket.on('registerHost', () => {
    hostSocket = socket;
    console.log('ホスト登録');
    socket.emit('queueUpdate', { currentTrack, userQueues });
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
    endTrackPlayback();
    playing = false;
    currentTrack = null; // 再生中データをリセット
    playNext();
  });

  // 曲追加
  socket.on('addVideo', ({ url, username }) => {
    const userId = socketIdToUserId[socket.id];
    const videoId = extractVideoId(url);
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const videoObj = { id: uniqueId, videoId, ownerUserId: userId, ownerName: username };

    if (!userQueues[userId]) userQueues[userId] = [];
    userQueues[userId].push(videoObj);

    broadcastAllQueues();

    // 再生してなければ開始
    if (!playing && hostSocket) {
      playNext();
    }
  });

  // スキップ要求
  socket.on('skipCurrent', () => {
    if (!currentTrack) {
      socket.emit('skipDenied');
      return;
    }

    // 履歴曲なら誰でもOK
    if (currentTrack.isHistory) {
      console.log(`履歴曲スキップ許可: ${currentTrack.videoId}`);
      endTrackPlayback();
      playNext();
      return;
    }

    const userId = socketIdToUserId[socket.id];
    if (currentTrack && currentTrack.ownerUserId === userId) {
      console.log(`スキップ許可: ${currentTrack.videoId}`);
      endTrackPlayback();
      playNext();
    } else {
      console.log('スキップ拒否: 権限なし');
      socket.emit('skipDenied');
    }
  });

  // 削除リクエストを受け取った時
  socket.on('removeVideo', (id) => {
    const userId = socketIdToUserId[socket.id];
    const userQueue = userQueues[userId];
    if (!userQueue) return;

    const index = userQueue.findIndex(item => item.id === id);
    if (index !== -1) {
      userQueue.splice(index, 1);
      console.log(`動画削除: id=${id} from user ${userId}`);
      broadcastAllQueues();
    } else {
      console.log(`削除拒否: id=${id}, userId=${userId} のキューに存在しない`);
      socket.emit('removeDenied', id);
    }
  });
  
  // 曲再生開始時
  function startTrackPlayback(track) {
    trackStartTime = Date.now();

    let history = loadHostHistory();
    if (!history.find(h => h.videoId === track.videoId)) {
      history.push({ videoId: track.videoId, name: track.name });
      saveHostHistory(history);
    }
    
    playing = true;
    hostSocket.emit('playVideo', track.videoId);
    broadcastAllQueues();
  }
  
  // 曲終了 / スキップ / 停止時の処理
  function endTrackPlayback() {
    if (trackStartTime === null) return;
    const elapsedSec = Math.floor((Date.now() - trackStartTime) / 1000);

    if(currentTrack.ownerUserId) {
      for (const userId in waitTimes) {
        if (userId !== currentTrack.ownerUserId) {
          waitTimes[userId].time += elapsedSec;
        }
      }
    }
    trackStartTime = null;
  }

  function playNext() {
    console.table(waitTimes); // ログ出力

    if (!hostSocket) {
      currentTrack = null;
      playing = false;
      broadcastAllQueues();
      return;
    }
    
    const sortedUsers = Object.values(waitTimes)
      .sort((a,b) => b.time - a.time);

    let foundTrack = false;
    
    for (const user of sortedUsers) {
      const userId = user.userId;
      const queue = userQueues[userId];
      if (queue && queue.length > 0) {
        currentTrack = queue.shift();
        startTrackPlayback(currentTrack);
        foundTrack = true;
        break;
      }
    }

    
    if (!foundTrack) {
      // 履歴からランダム再生
      const history = loadHostHistory();
      if (history.length > 0) {
        const randIndex = Math.floor(Math.random() * history.length);
        const historyTrack = {
          id: `history_${Date.now()}`,
          name: history[randIndex].name || '履歴の曲',
          videoId: history[randIndex].videoId,
          ownerName: null,
          isHistory: true
        };
        currentTrack = historyTrack;
        startTrackPlayback(historyTrack);
      } else {
        currentTrack = null;
        playing = false;
        broadcastAllQueues();
      }
    }
  }
});

server.listen(3000, () => {
  console.log('listening on *:3000');
});
