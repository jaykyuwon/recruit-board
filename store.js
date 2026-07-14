// API 클라이언트 + 상태 미러
// - 서버(/api/state, /api/action)와 통신하고, 화면 코드가 읽는
//   localStorage 미러(recruit-users/posts/scores)를 최신으로 유지한다.
// - 인증은 서버가 발급한 세션 토큰(Bearer)으로 하며,
//   자동 로그인이면 localStorage, 아니면 sessionStorage에 보관한다.
(function () {
  var TOKEN_KEY = "recruit-token";
  var SESSION_KEY = "recruit-session";

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  }

  function clearAuth() {
    [localStorage, sessionStorage].forEach(function (s) {
      s.removeItem(TOKEN_KEY);
      s.removeItem(SESSION_KEY);
    });
  }

  var latestState = null; // 최신 전체 상태(메모리) — 큰 상점 이미지는 여기서만 보관

  // 용량 초과 등으로 setItem이 실패해도 앱이 멈추지 않도록 감싼다
  function safeSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      // QuotaExceededError 등 — 무시하고 메모리(latestState)에서 읽음
      try { localStorage.removeItem(key); } catch (e2) { /* 무시 */ }
    }
  }

  function mirror(state) {
    if (!state) return;
    latestState = state;
    safeSet("recruit-users", state.users || {});
    safeSet("recruit-posts", state.posts || []);
    safeSet("recruit-scores", state.scores || {});
    safeSet("recruit-reports", state.reports || []);
    // 상점은 배경 이미지가 커서 localStorage 용량을 넘길 수 있으므로 저장하지 않고 메모리에만 둔다
    try { localStorage.removeItem("recruit-shop"); } catch (e) { /* 무시 */ }
    applySiteBg();
  }

  function getShop() {
    return (latestState && latestState.shop) ? latestState.shop : [];
  }

  // 현재 로그인 유저가 장착한 '사이트 배경'을 모든 페이지에 적용
  function applySiteBg() {
    try {
      var email = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      if (!email) return;
      var users = (latestState && latestState.users) || JSON.parse(localStorage.getItem("recruit-users") || "{}");
      var shop = getShop();
      var me = users[email];
      // 사이트 배경 표시가 꺼져 있으면 적용하지 않음
      var sitebgOn = !(me && me.cosmeticOn && me.cosmeticOn.sitebg === false);
      var id = (me && me.equipped && sitebgOn) ? me.equipped.sitebg : null;
      var item = null;
      for (var i = 0; i < shop.length; i++) { if (shop[i].id === id) { item = shop[i]; break; } }
      var apply = function () {
        if (!document.body) return;
        if (item) {
          // 반투명 흰색을 위에 얹어 본문 글자 가독성을 지키면서 배경을 은은히 비침
          document.body.style.background =
            "linear-gradient(rgba(255,255,255,0.72),rgba(255,255,255,0.72))," + item.value;
          document.body.style.backgroundSize = "cover";
          document.body.style.backgroundPosition = "center";
          document.body.style.backgroundAttachment = "fixed";
        } else {
          document.body.style.background = "";
        }
      };
      if (document.body) apply();
      else document.addEventListener("DOMContentLoaded", apply);
    } catch (e) { /* 무시 */ }
  }

  function toLogin() {
    clearAuth();
    if (!/login\.html$/.test(location.pathname)) location.replace("login.html");
  }

  var Api = {
    getToken: getToken,

    setAuth: function (token, email, persist) {
      clearAuth();
      var store = persist ? localStorage : sessionStorage;
      store.setItem(TOKEN_KEY, token);
      store.setItem(SESSION_KEY, email);
    },

    clearAuth: clearAuth,

    // 서버 액션 호출. 성공 시 응답의 최신 상태로 미러를 갱신한다.
    call: function (action, payload) {
      var body = { action: action };
      Object.keys(payload || {}).forEach(function (k) { body[k] = payload[k]; });
      var headers = { "Content-Type": "application/json" };
      var token = getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
      return fetch("/api/action", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().then(function (d) { return { status: r.status, data: d }; });
      }).then(function (r) {
        if (r.status === 401 && action !== "login" && action !== "signup") {
          toLogin();
          throw new Error("로그인이 필요합니다.");
        }
        if (!r.data.ok) throw new Error(r.data.error || "요청이 실패했습니다.");
        if (r.data.state) mirror(r.data.state);
        return r.data;
      });
    },

    // 서버 상태를 받아 미러 갱신
    refresh: function () {
      var token = getToken();
      if (!token) {
        toLogin();
        return Promise.resolve(null);
      }
      return fetch("/api/state", {
        headers: { "Authorization": "Bearer " + token }
      }).then(function (r) {
        return r.json().then(function (d) { return { status: r.status, data: d }; });
      }).then(function (r) {
        if (r.status === 401) {
          toLogin();
          return null;
        }
        if (r.data.ok) mirror(r.data.state);
        return r.data.state || null;
      }).catch(function () { return null; });
    },

    // 채팅 폴링용: 미러를 건드리지 않고 상태만 조회
    peek: function () {
      var token = getToken();
      if (!token) return Promise.resolve(null);
      return fetch("/api/state", {
        headers: { "Authorization": "Bearer " + token }
      }).then(function (r) { return r.json(); })
        .then(function (d) { return d.ok ? d.state : null; })
        .catch(function () { return null; });
    }
  };

  Api.getShop = getShop;
  Api.getState = function () { return latestState; };

  window.Api = Api;
  window.applySiteBg = applySiteBg;
  applySiteBg(); // 새로고침 응답 전, 캐시된 미러로 즉시 적용 (깜빡임 최소화)
  window.__storeReady = /login\.html$/.test(location.pathname)
    ? Promise.resolve(null)
    : Api.refresh();
})();
