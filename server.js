// 모집 게시판 서버 (Node.js, 외부 의존성 없음)
// - 정적 파일 서빙 + 인증/권한이 검증되는 액션 API
// - 비밀번호는 서버에서 salt+scrypt로 해싱, 세션 토큰으로 인증
// - 데이터는 data/data.json에 저장 (도커 볼륨으로 영속화)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8931;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const MAX_BODY = 45 * 1024 * 1024; // 45MB (상점 배경 이미지 업로드 넉넉히 포함, base64 팽창분 감안)
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30일
const ADMIN_EMAIL = "jaydenkyuwon@gmail.com";
// 최초 시드 전용 초기 비밀번호. 기존 data.json 이 있으면(관리자 계정 존재) 적용되지 않는다.
// 실제 값은 소스에 두지 않고 환경변수(.env)로 주입한다.
const ADMIN_INITIAL_PW = process.env.ADMIN_INITIAL_PW || "change-me-on-first-run";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

/* ── 저장소 ─────────────────────────────── */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: {}, posts: [], scores: {}, sessions: {}, reports: [], shop: [], spent: {} };

// 상점 아이템 종류: 개인 배너 / 개인 공고 배경 / 사이트 배경
const SHOP_TYPES = ["banner", "postbg", "sitebg"];

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (raw["recruit-users"] || raw["recruit-posts"]) {
      // 이전 버전(클라이언트 전체 저장) 데이터 마이그레이션
      db.users = {};
      const oldUsers = raw["recruit-users"] || {};
      Object.keys(oldUsers).forEach((email) => {
        const u = oldUsers[email];
        db.users[email] = {
          nickname: u.nickname || email.split("@")[0],
          legacySha: u.pw || null, // 예전 클라이언트 sha256 해시 — 첫 로그인 때 scrypt로 승격
          createdAt: u.createdAt || Date.now(),
          admin: !!u.admin,
          photo: u.photo
        };
      });
      db.posts = raw["recruit-posts"] || [];
      db.scores = raw["recruit-scores"] || {};
      db.sessions = {};
      saveDb();
    } else if (raw.users) {
      db = { users: {}, posts: [], scores: {}, sessions: {}, reports: [], shop: [], spent: {}, ...raw };
    }
  } catch (e) {
    console.error("데이터 로드 실패:", e.message);
  }
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db), "utf8");
}

/* ── 암호/세션 ───────────────────────────── */
function hashPw(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPw(user, password) {
  if (user.pwSalt && user.pwHash) {
    const hash = crypto.scryptSync(password, user.pwSalt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.pwHash));
  }
  if (user.legacySha) {
    // 이전 버전 호환: 클라이언트가 sha256으로 저장했던 계정
    const sha = crypto.createHash("sha256").update(password).digest("hex");
    return sha === user.legacySha;
  }
  return false;
}
function setPw(user, password) {
  const { salt, hash } = hashPw(password);
  user.pwSalt = salt;
  user.pwHash = hash;
  delete user.legacySha;
}

function createSession(email) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = { email, createdAt: Date.now() };
  return token;
}
function sessionUser(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    delete db.sessions[token];
    return null;
  }
  if (!db.users[s.email]) return null;
  if (db.users[s.email].disabled) {
    // 비활성화된 계정은 기존 세션도 무효
    delete db.sessions[token];
    return null;
  }
  return { email: s.email, token };
}

/* ── 관리자 시드 / 정규화 ─────────────────── */
function ensureAdmin() {
  if (!db.users[ADMIN_EMAIL]) {
    db.users[ADMIN_EMAIL] = {
      nickname: "관리자",
      createdAt: Date.now(),
      admin: true
    };
    setPw(db.users[ADMIN_EMAIL], ADMIN_INITIAL_PW);
    saveDb();
  } else if (db.users[ADMIN_EMAIL].nickname !== "관리자") {
    db.users[ADMIN_EMAIL].nickname = "관리자";
    saveDb();
  }
}
function normalizeUsers() {
  Object.keys(db.users).forEach((em) => {
    if (typeof db.users[em].temp !== "number") db.users[em].temp = 36.5; // 매너온도 기본값
    if (!Array.isArray(db.users[em].owned)) db.users[em].owned = []; // 구매한 아이템 id
    if (!db.users[em].equipped || typeof db.users[em].equipped !== "object")
      db.users[em].equipped = { banner: null, postbg: null, sitebg: null }; // 장착 슬롯
    if (db.users[em].bannerFit !== "cover" && db.users[em].bannerFit !== "contain")
      db.users[em].bannerFit = "cover"; // 배너 사진 표시 방식
    if (typeof db.users[em].bannerPos !== "number") db.users[em].bannerPos = 50; // 배너 상하 위치(%)
    // 꾸미기 종류별 표시 on/off (배너/공고배경/사이트배경). 이전 bannerOn 값을 이어받음
    if (!db.users[em].cosmeticOn || typeof db.users[em].cosmeticOn !== "object") {
      var prevBanner = (typeof db.users[em].bannerOn === "boolean") ? db.users[em].bannerOn : true;
      db.users[em].cosmeticOn = { banner: prevBanner, postbg: true, sitebg: true };
    }
    SHOP_TYPES.forEach((t) => {
      if (typeof db.users[em].cosmeticOn[t] !== "boolean") db.users[em].cosmeticOn[t] = true;
    });
    delete db.users[em].bannerOn; // 일반화된 cosmeticOn으로 대체
  });
  if (!db.reports) db.reports = [];
  db.reports.forEach((r) => { if (!r.type) r.type = "noshow"; }); // 이전 버전: 불참 신고만 있었음
  if (!Array.isArray(db.shop)) db.shop = [];
  if (!db.spent || typeof db.spent !== "object") db.spent = {}; // 누적 사용 포인트
}

/* ── 상점 ────────────────────────────────── */
function findItem(id) {
  return db.shop.find((x) => x.id === id) || null;
}
// 랭킹용 누적 포인트 = 현재 잔액 + 사용한 포인트 (구매해도 순위는 유지)
function totalEarned(email) {
  return (db.scores[email] || 0) + (db.spent[email] || 0);
}
// 포인트 소모 (잔액 차감 + 사용 누적)
function spendPoints(email, amount) {
  addScore(email, -amount);
  db.spent[email] = (db.spent[email] || 0) + amount;
}
// 획득 점수 회수 (공고 삭제·신청 취소 등): 누적 랭킹에서 실제로 빠지도록
// 잔액(scores)에서 먼저 차감하고, 부족분은 사용 누적(spent)에서 차감한다.
// (addScore는 0에서 클램프되고 spent를 못 건드려, 이미 포인트를 쓴 사람은 랭킹이 안 줄어드는 문제 해결)
function removeEarned(email, amount) {
  amount = Math.max(0, amount || 0);
  if (amount === 0) return;
  const bal = db.scores[email] || 0;
  if (bal >= amount) {
    db.scores[email] = bal - amount;
  } else {
    db.scores[email] = 0;
    db.spent[email] = Math.max(0, (db.spent[email] || 0) - (amount - bal));
  }
}
// 상점 필드 방어적 초기화 (구버전 계정/경합 대비)
function ensureCosmetics(u) {
  if (!Array.isArray(u.owned)) u.owned = [];
  if (!u.equipped || typeof u.equipped !== "object")
    u.equipped = { banner: null, postbg: null, sitebg: null };
}

function normalizePosts() {
  db.posts.forEach((p) => {
    if (!p.id) p.id = crypto.randomBytes(8).toString("hex");
    if (!p.capacity || p.capacity < 1) p.capacity = 1;
    if (!p.applicants) p.applicants = [];
    if (!p.score || p.score < 1) p.score = 5;
    if (!p.status) p.status = "active";
    if (p.awarded === undefined) p.awarded = true;
    if (!p.applicantPts) {
      p.applicantPts = {};
      p.applicants.forEach((em) => { p.applicantPts[em] = p.score; });
    }
    if (!p.comments) p.comments = [];
    if (!p.chat) p.chat = [];
    if (p.awarded && p.awardedPts === undefined) p.awardedPts = 10; // 이전 버전: 고정 10점 지급이었음
    if (p.category === "rival" && !(p.winScore >= 1)) p.winScore = 10; // 승리 점수 기본값
  });
}

/* ── 점수 ────────────────────────────────── */
function addScore(email, delta) {
  db.scores[email] = (db.scores[email] || 0) + delta;
  if (db.scores[email] < 0) db.scores[email] = 0;
}

// 매너온도 비례 지급: 36.5°C = 100% 기준
// 제곱근 곡선으로 완만하게 — 고온 보너스가 기하급수적으로 커지지 않도록
function scaledPoints(points, email) {
  const u = db.users[email];
  const temp = (u && typeof u.temp === "number") ? u.temp : 36.5;
  return Math.max(0, Math.round(points * Math.sqrt(temp / 36.5)));
}

// 공고 작성 비용: 참가 점수 5점당 1점 소모 (기본 5점 공고 = 1점)
// 5점 초과 공고는 관리자 승인 시점에 차감
function postCost(score) {
  return Math.max(1, Math.ceil(score / 5));
}

// 활동 보상 매너온도 (취소/삭제 시 같은 값으로 회수해 반복 채굴 방지)
const TEMP_GAIN_POST = 0.1;  // 공고 게시 확정
const TEMP_GAIN_APPLY = 0.1; // 참여 신청
const TEMP_GAIN_WIN = 0.3;   // 대결 승리

function addTemp(email, delta) {
  const u = db.users[email];
  if (!u) return;
  u.temp = Math.min(99, Math.max(0, Math.round((u.temp + delta) * 10) / 10));
}

/* 최고 관리자(소유자) 또는 권한을 부여받은 관리자인지 */
function isAdminEmail(email) {
  if (!email) return false;
  if (email === ADMIN_EMAIL) return true;
  const u = db.users[email];
  return !!(u && u.admin);
}

/* ── 클라이언트용 상태 (권한별로 걸러서 내려줌) ── */
function stateFor(email) {
  const isAdmin = isAdminEmail(email);
  const users = {};
  Object.keys(db.users).forEach((em) => {
    const u = db.users[em];
    users[em] = {
      nickname: u.nickname, photo: u.photo, createdAt: u.createdAt,
      admin: !!u.admin, temp: u.temp, disabled: !!u.disabled,
      equipped: u.equipped || { banner: null, postbg: null, sitebg: null },
      bannerFit: u.bannerFit || "cover",
      bannerPos: (typeof u.bannerPos === "number") ? u.bannerPos : 50,
      cosmeticOn: u.cosmeticOn || { banner: true, postbg: true, sitebg: true },
      spent: db.spent[em] || 0,
      // 소유 목록은 본인·관리자에게만
      owned: (em === email || isAdmin) ? (u.owned || []).slice() : undefined
    };
  });
  const posts = db.posts
    .filter((p) => p.status === "active" || p.authorId === email || isAdmin)
    .map((p) => {
      const participant = p.authorId === email || isAdmin || p.applicants.indexOf(email) !== -1;
      const copy = { ...p };
      if (!participant) copy.chat = []; // 채팅은 참여자에게만
      return copy;
    });
  const me = db.users[email];
  return {
    me: { email, nickname: me.nickname, isAdmin, isOwner: email === ADMIN_EMAIL },
    users,
    posts,
    scores: { ...db.scores },
    shop: db.shop.slice(),
    // 신고 내역은 신고 작성자 본인과 관리자만 볼 수 있음
    reports: isAdmin ? db.reports.slice() : db.reports.filter((r) => r.reporter === email)
  };
}

/* ── 액션 핸들러 ─────────────────────────── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function findPost(id) {
  const p = db.posts.find((x) => x.id === id);
  if (!p) throw err(404, "공고를 찾을 수 없습니다.");
  return p;
}

// 계정 관련 데이터 전체 정리 (공고, 신청, 점수, 세션)
function purgeAccount(email) {
  for (let i = db.posts.length - 1; i >= 0; i--) {
    const p = db.posts[i];
    if (p.authorId === email) {
      p.applicants.forEach((em) => {
        if (em !== email) {
          addScore(em, -(p.applicantPts[em] || p.score));
          addTemp(em, -TEMP_GAIN_APPLY);
        }
      });
      if (p.winner && p.winner !== email) {
        addScore(p.winner, -(p.winnerPts || 0));
        addTemp(p.winner, -TEMP_GAIN_WIN);
      }
      db.posts.splice(i, 1);
    } else {
      const at = p.applicants.indexOf(email);
      if (at !== -1) {
        p.applicants.splice(at, 1);
        delete p.applicantPts[email];
      }
    }
  }
  delete db.users[email];
  delete db.scores[email];
  delete db.spent[email];
  db.reports = db.reports.filter((r) => r.reporter !== email && r.reported !== email);
  Object.keys(db.sessions).forEach((t) => {
    if (db.sessions[t].email === email) delete db.sessions[t];
  });
}

const actions = {
  /* 인증 (토큰 불필요) */
  signup(_auth, p) {
    const email = String(p.email || "").trim().toLowerCase();
    const nickname = String(p.nickname || "").trim();
    const password = String(p.password || "");
    if (!EMAIL_RE.test(email)) throw err(400, "올바른 이메일 주소를 입력해주세요.");
    if (!nickname || nickname.length > 20) throw err(400, "닉네임은 1~20자로 입력해주세요.");
    if (password.length < 6) throw err(400, "비밀번호는 6자 이상이어야 합니다.");
    if (db.users[email]) throw err(400, "이미 가입된 이메일입니다. 로그인해주세요.");
    if (Object.keys(db.users).some((em) => db.users[em].nickname === nickname))
      throw err(400, "이미 사용 중인 닉네임입니다.");
    db.users[email] = {
      nickname, createdAt: Date.now(), temp: 36.5,
      owned: [], equipped: { banner: null, postbg: null, sitebg: null },
      bannerFit: "cover", bannerPos: 50,
      cosmeticOn: { banner: true, postbg: true, sitebg: true }
    };
    setPw(db.users[email], password);
    const token = createSession(email);
    return { token, email, state: stateFor(email) };
  },

  login(_auth, p) {
    const nickname = String(p.nickname || "").trim();
    const password = String(p.password || "");
    const email = Object.keys(db.users).find((em) => db.users[em].nickname === nickname);
    if (!email || !verifyPw(db.users[email], password))
      throw err(401, "닉네임 또는 비밀번호가 올바르지 않습니다.");
    if (db.users[email].disabled)
      throw err(403, "비활성화된 계정입니다. 관리자에게 문의해주세요.");
    if (db.users[email].legacySha) setPw(db.users[email], password); // 구형 해시 승격
    const token = createSession(email);
    return { token, email, state: stateFor(email) };
  },

  logout(auth) {
    if (auth) delete db.sessions[auth.token];
    return {};
  },

  /* 공고 */
  createPost(auth, p) {
    const title = String(p.title || "").trim();
    const detail = String(p.detail || "").trim();
    const category = p.category === "mate" ? "mate" : "rival";
    const capacity = parseInt(p.capacity, 10);
    const score = parseInt(p.score, 10);
    if (!title || title.length > 80) throw err(400, "공고 이름은 1~80자로 입력해주세요.");
    if (!detail || detail.length > 3000) throw err(400, "세부 내용은 1~3000자로 입력해주세요.");
    if (!(capacity >= 1 && capacity <= 99)) throw err(400, "모집 인원은 1~99명이어야 합니다.");
    if (!(score >= 1 && score <= 999)) throw err(400, "참여 점수는 1~999점이어야 합니다.");
    let winScore;
    if (category === "rival") {
      winScore = parseInt(p.winScore, 10);
      if (!(winScore >= 1 && winScore <= 999)) throw err(400, "승리 점수는 1~999점이어야 합니다.");
    }
    const deadline = parseInt(p.deadline, 10);
    if (!(deadline > Date.now())) throw err(400, "모집 기한은 현재 시각 이후로 설정해주세요.");
    if (deadline > Date.now() + 366 * 24 * 3600 * 1000) throw err(400, "모집 기한은 1년 이내로 설정해주세요.");
    // 기본값(참여 5점, 승리 10점)이 아니거나 모집 인원이 3명을 넘으면 관리자 승인 필요
    const status = (score === 5 && (category !== "rival" || winScore === 10) && capacity <= 3)
      ? "active" : "pending";
    const post = {
      id: crypto.randomBytes(8).toString("hex"),
      category, title, detail, capacity, score, status,
      winScore, deadline,
      awarded: status === "active",
      applicants: [], applicantPts: {}, comments: [], chat: [],
      authorId: auth.email, createdAt: Date.now()
    };
    if (status === "active") {
      post.awardedPts = scaledPoints(10, auth.email); // 매너온도 비례 지급
      addScore(auth.email, post.awardedPts);
      post.costPts = postCost(score); // 작성 비용 (삭제해도 환불 없음)
      addScore(auth.email, -post.costPts);
      addTemp(auth.email, TEMP_GAIN_POST);
    }
    db.posts.push(post);
    return {};
  },

  updatePost(auth, p) {
    const post = findPost(p.id);
    const isAdmin = isAdminEmail(auth.email);
    if (post.authorId !== auth.email && !isAdmin) throw err(403, "공고를 수정할 권한이 없습니다.");
    const title = String(p.title || "").trim();
    const detail = String(p.detail || "").trim();
    const category = p.category === "mate" ? "mate" : "rival";
    const capacity = parseInt(p.capacity, 10);
    const score = parseInt(p.score, 10);
    if (!title || title.length > 80) throw err(400, "공고 이름은 1~80자로 입력해주세요.");
    if (!detail || detail.length > 3000) throw err(400, "세부 내용은 1~3000자로 입력해주세요.");
    if (!(capacity >= 1 && capacity <= 99)) throw err(400, "모집 인원은 1~99명이어야 합니다.");
    if (!(score >= 1 && score <= 999)) throw err(400, "참여 점수는 1~999점이어야 합니다.");
    if (capacity < post.applicants.length)
      throw err(400, "이미 신청한 인원(" + post.applicants.length + "명)보다 적게 줄일 수 없습니다.");
    let winScore;
    if (category === "rival") {
      winScore = parseInt(p.winScore, 10);
      if (!(winScore >= 1 && winScore <= 999)) throw err(400, "승리 점수는 1~999점이어야 합니다.");
    }
    if (post.winner && category !== "rival")
      throw err(400, "승자가 확정된 공고는 동료 공고로 바꿀 수 없습니다.");
    const deadline = parseInt(p.deadline, 10);
    if (!(deadline > Date.now())) throw err(400, "모집 기한은 현재 시각 이후로 설정해주세요.");
    if (deadline > Date.now() + 366 * 24 * 3600 * 1000) throw err(400, "모집 기한은 1년 이내로 설정해주세요.");
    // 기본값이 아니거나 승인받은 값에서 바뀌면 재승인 필요
    const scoreOk = score === 5 || (score === post.score && post.status === "active");
    const winOk = category !== "rival" || winScore === 10 ||
      (winScore === post.winScore && post.status === "active");
    const capOk = capacity <= 3 || (capacity === post.capacity && post.status === "active");
    const newStatus = (scoreOk && winOk && capOk) ? "active" : "pending";
    Object.assign(post, { category, title, detail, capacity, score, winScore, deadline, status: newStatus });
    if (newStatus === "active" && !post.awarded) {
      post.awarded = true;
      post.awardedPts = scaledPoints(10, post.authorId); // 매너온도 비례 지급
      addScore(post.authorId, post.awardedPts);
      post.costPts = postCost(post.score); // 작성 비용
      addScore(post.authorId, -post.costPts);
      addTemp(post.authorId, TEMP_GAIN_POST);
    }
    return {};
  },

  deletePost(auth, p) {
    const post = findPost(p.id);
    const isAdmin = isAdminEmail(auth.email);
    if (post.authorId !== auth.email && !isAdmin) throw err(403, "공고를 삭제할 권한이 없습니다.");
    if (post.awarded) {
      removeEarned(post.authorId, post.awardedPts !== undefined ? post.awardedPts : 10);
      addTemp(post.authorId, -TEMP_GAIN_POST);
    }
    post.applicants.forEach((em) => {
      removeEarned(em, post.applicantPts[em] || post.score);
      addTemp(em, -TEMP_GAIN_APPLY);
    });
    if (post.winner) {
      removeEarned(post.winner, post.winnerPts || 0);
      addTemp(post.winner, -TEMP_GAIN_WIN);
    }
    db.posts.splice(db.posts.indexOf(post), 1);
    return {};
  },

  applyToggle(auth, p) {
    const post = findPost(p.id);
    if (post.authorId === auth.email) throw err(400, "내 공고에는 신청할 수 없습니다.");
    if (auth.email === ADMIN_EMAIL) throw err(400, "관리자는 신청할 수 없습니다.");
    if (post.status !== "active") throw err(400, "게시 중인 공고가 아닙니다.");
    // 기한이 지나면 신청도 취소도 불가
    if (typeof post.deadline === "number" && Date.now() > post.deadline)
      throw err(400, "모집 기한이 지난 공고입니다.");
    const at = post.applicants.indexOf(auth.email);
    if (at !== -1) {
      post.applicants.splice(at, 1);
      removeEarned(auth.email, post.applicantPts[auth.email] || post.score);
      addTemp(auth.email, -TEMP_GAIN_APPLY);
      delete post.applicantPts[auth.email];
    } else {
      if (post.applicants.length >= post.capacity) throw err(400, "모집이 완료된 공고입니다.");
      post.applicants.push(auth.email);
      const pts = scaledPoints(post.score, auth.email); // 매너온도 비례 지급
      post.applicantPts[auth.email] = pts;
      addScore(auth.email, pts);
      addTemp(auth.email, TEMP_GAIN_APPLY);
    }
    return {};
  },

  kickApplicant(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 신청을 취소시킬 수 있습니다.");
    const post = findPost(p.postId);
    const email = String(p.email || "");
    const at = post.applicants.indexOf(email);
    if (at === -1) throw err(404, "해당 신청자가 없습니다.");
    post.applicants.splice(at, 1);
    removeEarned(email, post.applicantPts[email] || post.score);
    addTemp(email, -TEMP_GAIN_APPLY);
    delete post.applicantPts[email];
    return {};
  },

  /* 댓글/채팅 */
  addComment(auth, p) {
    const post = findPost(p.postId);
    const isAdmin = isAdminEmail(auth.email);
    if (post.status !== "active" && post.authorId !== auth.email && !isAdmin)
      throw err(403, "댓글을 달 수 없는 공고입니다.");
    const text = String(p.text || "").trim();
    if (!text || text.length > 200) throw err(400, "댓글은 1~200자로 입력해주세요.");
    post.comments.push({
      id: crypto.randomBytes(8).toString("hex"),
      author: auth.email, text, createdAt: Date.now()
    });
    return {};
  },

  deleteComment(auth, p) {
    const post = findPost(p.postId);
    const c = post.comments.find((x) => x.id === p.commentId);
    if (!c) throw err(404, "댓글을 찾을 수 없습니다.");
    if (c.author !== auth.email && !isAdminEmail(auth.email))
      throw err(403, "댓글을 삭제할 권한이 없습니다.");
    post.comments.splice(post.comments.indexOf(c), 1);
    return {};
  },

  sendChat(auth, p) {
    const post = findPost(p.postId);
    const participant = post.authorId === auth.email ||
      isAdminEmail(auth.email) ||
      post.applicants.indexOf(auth.email) !== -1;
    if (!participant) throw err(403, "참여자만 채팅할 수 있습니다.");
    const text = String(p.text || "").trim();
    if (!text || text.length > 500) throw err(400, "메시지는 1~500자로 입력해주세요.");
    post.chat.push({
      id: crypto.randomBytes(8).toString("hex"),
      author: auth.email, text, createdAt: Date.now()
    });
    return {};
  },

  deleteChat(auth, p) {
    const post = findPost(p.postId);
    const m = post.chat.find((x) => x.id === p.chatId);
    if (!m) throw err(404, "메시지를 찾을 수 없습니다.");
    if (m.author !== auth.email && !isAdminEmail(auth.email))
      throw err(403, "메시지를 삭제할 권한이 없습니다.");
    post.chat.splice(post.chat.indexOf(m), 1);
    return {};
  },

  /* 라이벌 대결 승자 확정 */
  declareWinner(auth, p) {
    const post = findPost(p.postId);
    if (post.category !== "rival") throw err(400, "라이벌 공고에서만 승자를 확정할 수 있습니다.");
    if (post.authorId !== auth.email) throw err(403, "공고 작성자만 승자를 확정할 수 있습니다.");
    if (post.status !== "active") throw err(400, "게시 중인 공고가 아닙니다.");
    if (post.winner) throw err(400, "이미 승자가 확정된 공고입니다.");
    const winner = String(p.email || "");
    if (winner !== post.authorId && post.applicants.indexOf(winner) === -1)
      throw err(400, "승자는 이 공고의 참여자여야 합니다.");
    const pts = scaledPoints(post.winScore || 10, winner); // 매너온도 비례 지급
    post.winner = winner;
    post.winnerPts = pts;
    addScore(winner, pts);
    addTemp(winner, TEMP_GAIN_WIN);
    return {};
  },

  /* 매너온도 / 불참 신고 */
  reportNoShow(auth, p) {
    const post = findPost(p.postId);
    const target = String(p.email || "");
    const isAuthor = post.authorId === auth.email;
    const isApplicant = post.applicants.indexOf(auth.email) !== -1;
    if (isAuthor) {
      // 작성자 → 신청자 신고
      if (post.applicants.indexOf(target) === -1) throw err(400, "이 공고의 신청자가 아닙니다.");
    } else if (isApplicant) {
      // 참여자 → 작성자 신고
      if (target !== post.authorId) throw err(400, "참여자는 공고 작성자만 신고할 수 있습니다.");
    } else {
      throw err(403, "이 공고의 작성자 또는 참여자만 신고할 수 있습니다.");
    }
    const dup = db.reports.some((r) =>
      r.status === "pending" && r.postId === post.id && r.reported === target && r.reporter === auth.email
    );
    if (dup) throw err(400, "이미 접수되어 처리 대기 중인 신고입니다.");
    const reason = String(p.reason || "").trim().slice(0, 200);
    db.reports.push({
      id: crypto.randomBytes(8).toString("hex"),
      type: "noshow",
      postId: post.id,
      postTitle: post.title,
      reporter: auth.email,
      reported: target,
      reason,
      status: "pending",
      createdAt: Date.now()
    });
    return {};
  },

  // 부정 점수 취득 등 부정행위 신고 (모든 회원 가능)
  reportFraud(auth, p) {
    const target = String(p.email || "");
    if (!db.users[target]) throw err(404, "회원을 찾을 수 없습니다.");
    if (target === auth.email) throw err(400, "자기 자신은 신고할 수 없습니다.");
    if (target === ADMIN_EMAIL) throw err(400, "관리자는 신고할 수 없습니다.");
    const reason = String(p.reason || "").trim();
    if (!reason || reason.length > 200) throw err(400, "신고 사유를 1~200자로 입력해주세요.");
    const dup = db.reports.some((r) =>
      r.status === "pending" && r.type === "fraud" &&
      r.reporter === auth.email && r.reported === target
    );
    if (dup) throw err(400, "이미 접수되어 처리 대기 중인 신고입니다.");
    db.reports.push({
      id: crypto.randomBytes(8).toString("hex"),
      type: "fraud",
      reporter: auth.email,
      reported: target,
      reason,
      status: "pending",
      createdAt: Date.now()
    });
    return {};
  },

  resolveReport(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 신고를 처리할 수 있습니다.");
    const report = db.reports.find((r) => r.id === p.id && r.status === "pending");
    if (!report) throw err(404, "처리 대기 중인 신고를 찾을 수 없습니다.");
    const penalty = parseFloat(p.penalty);
    if (!(penalty >= 0.1 && penalty <= 10)) throw err(400, "차감 온도는 0.1~10 사이여야 합니다.");
    const scorePenalty = p.scorePenalty ? parseInt(p.scorePenalty, 10) : 0;
    if (!(scorePenalty >= 0 && scorePenalty <= 9999)) throw err(400, "차감 점수가 올바르지 않습니다.");
    const target = db.users[report.reported];
    if (target) {
      target.temp = Math.max(0, Math.round((target.temp - penalty) * 10) / 10);
      if (scorePenalty > 0) addScore(report.reported, -scorePenalty);
    }
    report.status = "accepted";
    report.penalty = penalty;
    if (scorePenalty > 0) report.scorePenalty = scorePenalty;
    report.resolvedAt = Date.now();
    return {};
  },

  dismissReport(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 신고를 처리할 수 있습니다.");
    const report = db.reports.find((r) => r.id === p.id && r.status === "pending");
    if (!report) throw err(404, "처리 대기 중인 신고를 찾을 수 없습니다.");
    report.status = "dismissed";
    report.resolvedAt = Date.now();
    return {};
  },

  adjustTemp(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 매너온도를 조정할 수 있습니다.");
    const email = String(p.email || "");
    if (!db.users[email]) throw err(404, "회원을 찾을 수 없습니다.");
    const delta = parseFloat(p.delta);
    if (!delta || Math.abs(delta) > 20) throw err(400, "조정 온도가 올바르지 않습니다.");
    const u = db.users[email];
    u.temp = Math.min(99, Math.max(0, Math.round((u.temp + delta) * 10) / 10));
    return {};
  },

  /* 관리자 */
  approvePost(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 승인할 수 있습니다.");
    const post = findPost(p.id);
    // 승인하면서 점수를 조정할 수 있음
    if (p.score !== undefined) {
      const score = parseInt(p.score, 10);
      if (!(score >= 1 && score <= 999)) throw err(400, "참여 점수는 1~999점이어야 합니다.");
      post.score = score;
    }
    if (p.winScore !== undefined && post.category === "rival") {
      const winScore = parseInt(p.winScore, 10);
      if (!(winScore >= 1 && winScore <= 999)) throw err(400, "승리 점수는 1~999점이어야 합니다.");
      post.winScore = winScore;
    }
    post.status = "active";
    if (!post.awarded) {
      post.awarded = true;
      post.awardedPts = scaledPoints(10, post.authorId); // 매너온도 비례 지급
      addScore(post.authorId, post.awardedPts);
      post.costPts = postCost(post.score); // 작성 비용 (승인된 최종 점수 기준)
      addScore(post.authorId, -post.costPts);
      addTemp(post.authorId, TEMP_GAIN_POST);
    }
    return {};
  },

  rejectPost(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 거절할 수 있습니다.");
    findPost(p.id).status = "rejected";
    return {};
  },

  setDisabled(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 계정을 비활성화할 수 있습니다.");
    const email = String(p.email || "");
    if (email === ADMIN_EMAIL) throw err(400, "관리자 계정은 비활성화할 수 없습니다.");
    const user = db.users[email];
    if (!user) throw err(404, "회원을 찾을 수 없습니다.");
    if (user.admin && auth.email !== ADMIN_EMAIL)
      throw err(403, "다른 관리자 계정은 최고 관리자만 비활성화할 수 있습니다.");
    if (p.disabled) {
      user.disabled = true;
      // 접속 중인 세션도 즉시 종료
      Object.keys(db.sessions).forEach((t) => {
        if (db.sessions[t].email === email) delete db.sessions[t];
      });
    } else {
      delete user.disabled;
    }
    return {};
  },

  // 관리자 권한 부여/회수 — 최고 관리자(소유자)만 가능
  setAdmin(auth, p) {
    if (auth.email !== ADMIN_EMAIL) throw err(403, "관리자 권한은 최고 관리자만 변경할 수 있습니다.");
    const email = String(p.email || "");
    if (email === ADMIN_EMAIL) throw err(400, "최고 관리자 권한은 변경할 수 없습니다.");
    const user = db.users[email];
    if (!user) throw err(404, "회원을 찾을 수 없습니다.");
    if (p.admin) {
      user.admin = true;
    } else {
      delete user.admin;
    }
    return {};
  },

  adjustScore(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 점수를 조정할 수 있습니다.");
    const email = String(p.email || "");
    if (!db.users[email]) throw err(404, "회원을 찾을 수 없습니다.");
    const delta = parseInt(p.delta, 10);
    if (!delta || Math.abs(delta) > 9999) throw err(400, "조정 점수가 올바르지 않습니다.");
    // 차감은 누적(랭킹)에서 실제로 빠지도록 removeEarned 사용 (잔액→부족분은 spent에서).
    // 지급(양수)은 잔액에 그대로 더한다.
    if (delta >= 0) addScore(email, delta);
    else removeEarned(email, -delta);
    return {};
  },

  /* 상점 (관리자가 품목 추가/삭제) */
  addShopItem(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 상품을 추가할 수 있습니다.");
    const type = String(p.type || "");
    if (SHOP_TYPES.indexOf(type) === -1) throw err(400, "상품 종류가 올바르지 않습니다.");
    const name = String(p.name || "").trim();
    if (!name || name.length > 40) throw err(400, "상품 이름은 1~40자로 입력해주세요.");
    const price = parseInt(p.price, 10);
    if (!(price >= 0 && price <= 1000000)) throw err(400, "가격은 0~1,000,000점이어야 합니다.");
    const value = String(p.value || "").trim();
    if (!value) throw err(400, "배경 값(색/그라데이션/이미지)을 입력해주세요.");
    if (value.length > 40000000) throw err(400, "이미지가 너무 큽니다. 더 작은 파일을 사용해주세요.");
    db.shop.push({
      id: crypto.randomBytes(8).toString("hex"),
      type, name, price, value, createdAt: Date.now()
    });
    return {};
  },

  deleteShopItem(auth, p) {
    if (!isAdminEmail(auth.email)) throw err(403, "관리자만 상품을 삭제할 수 있습니다.");
    const idx = db.shop.findIndex((x) => x.id === p.id);
    if (idx === -1) throw err(404, "상품을 찾을 수 없습니다.");
    db.shop.splice(idx, 1);
    // 소유·장착 기록에서도 제거 (환불은 없음)
    Object.keys(db.users).forEach((em) => {
      const u = db.users[em];
      if (Array.isArray(u.owned)) u.owned = u.owned.filter((iid) => iid !== p.id);
      if (u.equipped) SHOP_TYPES.forEach((t) => { if (u.equipped[t] === p.id) u.equipped[t] = null; });
    });
    return {};
  },

  buyItem(auth, p) {
    const item = findItem(p.id);
    if (!item) throw err(404, "상품을 찾을 수 없습니다.");
    const u = db.users[auth.email];
    ensureCosmetics(u);
    if (u.owned.indexOf(item.id) !== -1) throw err(400, "이미 보유한 상품입니다.");
    if ((db.scores[auth.email] || 0) < item.price) throw err(400, "포인트가 부족합니다.");
    spendPoints(auth.email, item.price);
    u.owned.push(item.id);
    u.equipped[item.type] = item.id; // 구매하면 바로 장착
    return {};
  },

  equipItem(auth, p) {
    const u = db.users[auth.email];
    ensureCosmetics(u);
    const type = String(p.type || "");
    if (SHOP_TYPES.indexOf(type) === -1) throw err(400, "상품 종류가 올바르지 않습니다.");
    if (p.id === null || p.id === "" || p.id === undefined) {
      u.equipped[type] = null; // 장착 해제
      return {};
    }
    const item = findItem(String(p.id));
    if (!item) throw err(404, "상품을 찾을 수 없습니다.");
    if (item.type !== type) throw err(400, "상품 종류가 슬롯과 맞지 않습니다.");
    if (u.owned.indexOf(item.id) === -1) throw err(403, "보유하지 않은 상품입니다.");
    u.equipped[type] = item.id;
    return {};
  },

  // 프로필 배너 사진 표시 방식(채우기/전체보기)과 상하 위치 조절
  setBannerView(auth, p) {
    const u = db.users[auth.email];
    u.bannerFit = p.fit === "contain" ? "contain" : "cover";
    let pos = parseInt(p.pos, 10);
    if (!(pos >= 0 && pos <= 100)) pos = 50;
    u.bannerPos = pos;
    return {};
  },

  // 꾸미기 종류별 표시 on/off (배너/공고배경/사이트배경)
  setCosmeticOn(auth, p) {
    const type = String(p.type || "");
    if (SHOP_TYPES.indexOf(type) === -1) throw err(400, "종류가 올바르지 않습니다.");
    const u = db.users[auth.email];
    if (!u.cosmeticOn || typeof u.cosmeticOn !== "object")
      u.cosmeticOn = { banner: true, postbg: true, sitebg: true };
    u.cosmeticOn[type] = !!p.on;
    return {};
  },

  /* 프로필 */
  setNickname(auth, p) {
    if (auth.email === ADMIN_EMAIL) throw err(400, "관리자 닉네임은 변경할 수 없습니다.");
    const nickname = String(p.nickname || "").trim();
    if (!nickname || nickname.length > 20) throw err(400, "닉네임은 1~20자로 입력해주세요.");
    const taken = Object.keys(db.users).some(
      (em) => em !== auth.email && db.users[em].nickname === nickname
    );
    if (taken) throw err(400, "이미 사용 중인 닉네임입니다.");
    db.users[auth.email].nickname = nickname;
    return {};
  },

  setPassword(auth, p) {
    const user = db.users[auth.email];
    if (!verifyPw(user, String(p.current || ""))) throw err(400, "현재 비밀번호가 올바르지 않습니다.");
    const next = String(p.next || "");
    if (next.length < 6) throw err(400, "새 비밀번호는 6자 이상이어야 합니다.");
    setPw(user, next);
    return {};
  },

  setPhoto(auth, p) {
    const user = db.users[auth.email];
    if (p.photo === null || p.photo === undefined || p.photo === "") {
      delete user.photo;
      return {};
    }
    const photo = String(p.photo);
    if (!photo.startsWith("data:image/")) throw err(400, "이미지 형식이 아닙니다.");
    if (photo.length > 300 * 1024) throw err(400, "이미지가 너무 큽니다.");
    user.photo = photo;
    return {};
  },

  deleteAccount(auth, p) {
    const target = p.email ? String(p.email) : auth.email;
    if (target === ADMIN_EMAIL) throw err(400, "관리자 계정은 삭제할 수 없습니다.");
    if (target !== auth.email && !isAdminEmail(auth.email))
      throw err(403, "다른 회원을 삭제할 권한이 없습니다.");
    if (target !== auth.email && db.users[target] && db.users[target].admin && auth.email !== ADMIN_EMAIL)
      throw err(403, "다른 관리자 계정은 최고 관리자만 삭제할 수 있습니다.");
    if (!db.users[target]) throw err(404, "회원을 찾을 수 없습니다.");
    purgeAccount(target);
    return { deleted: target };
  }
};

const PUBLIC_ACTIONS = ["signup", "login"];

/* ── HTTP 서버 ───────────────────────────── */
loadDb();
ensureAdmin();
normalizeUsers();
normalizePosts();
saveDb();

function sendJson(res, status, obj) {
  const out = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(out);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  console.log(req.method + " " + pathname);

  /* 상태 조회 */
  if (pathname === "/api/state" && req.method === "GET") {
    const auth = sessionUser(req);
    if (!auth) return sendJson(res, 401, { ok: false, error: "로그인이 필요합니다." });
    return sendJson(res, 200, { ok: true, state: stateFor(auth.email) });
  }

  /* 액션 */
  if (pathname === "/api/action" && req.method === "POST") {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        sendJson(res, 413, { ok: false, error: "요청이 너무 큽니다." });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "잘못된 요청입니다." });
      }
      const name = String(payload.action || "");
      const handler = actions[name];
      if (!handler) return sendJson(res, 400, { ok: false, error: "알 수 없는 동작입니다." });
      const auth = sessionUser(req);
      if (!auth && PUBLIC_ACTIONS.indexOf(name) === -1)
        return sendJson(res, 401, { ok: false, error: "로그인이 필요합니다." });
      try {
        const result = handler(auth, payload) || {};
        saveDb();
        // deleteAccount로 본인이 사라진 경우 state 생략
        const email = result.token ? result.email : auth && auth.email;
        const state = email && db.users[email] ? stateFor(email) : null;
        return sendJson(res, 200, { ok: true, ...result, state: result.state || state });
      } catch (e) {
        saveDb();
        return sendJson(res, e.status || 500, { ok: false, error: e.message || "서버 오류" });
      }
    });
    return;
  }

  /* 정적 파일 */
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const full = path.normalize(path.join(ROOT, filePath));
  if (!full.startsWith(ROOT + path.sep) || full.startsWith(DATA_DIR + path.sep) || full === DATA_FILE) {
    res.writeHead(404);
    res.end("404 Not Found");
    return;
  }
  fs.readFile(full, (fsErr, bytes) => {
    if (fsErr) {
      res.writeHead(404);
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // 배포 즉시 반영되도록 CDN/브라우저 캐시 금지
      "Cache-Control": "no-store"
    });
    res.end(bytes);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("recruit-board listening on http://0.0.0.0:" + PORT);
});
