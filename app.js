(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var toastEl = $("#toast");
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  /* ---------- Supabase (로그인 + 캘린더) ---------- */
  var SUPABASE_URL = "https://usitagcnxunhfbwglheg.supabase.co";
  var SUPABASE_KEY = "sb_publishable_gAS5WkkRoTYlJ2jE6pAzkg_F39PDeJZ";
  var sb = (typeof supabase !== "undefined") ? supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
  var currentUser = null;

  var state = {
    office: null,      // { lat, lng, address }
    cafeSeg: "exclude",
    favorites: new Set(),
    lastSearchKind: null, // for the "다시 추천받기" shuffle tag
    map: null,
    markers: []
  };

  var geocoder = null;
  var places = null;
  var kakaoReady = false;

  function initKakao() {
    if (typeof kakao === "undefined" || !kakao.maps) {
      toast("카카오맵 SDK를 불러오지 못했어요. 인터넷 연결을 확인해주세요.");
      return;
    }
    kakao.maps.load(function () {
      geocoder = new kakao.maps.services.Geocoder();
      places = new kakao.maps.services.Places();
      kakaoReady = true;
    });
  }
  initKakao();

  /* ---------- 회사 위치 검색 (Geocoder → Places 폴백) ---------- */
  function resolveOffice(query, onDone) {
    if (!kakaoReady) { toast("카카오맵을 불러오는 중이에요. 잠시 후 다시 시도해주세요."); return; }
    if (!query || !query.trim()) { toast("회사 위치를 입력해주세요."); return; }

    geocoder.addressSearch(query, function (result, status) {
      if (status === kakao.maps.services.Status.OK && result.length) {
        var r = result[0];
        state.office = { lat: Number(r.y), lng: Number(r.x), address: r.address_name || query };
        $("#resolvedLoc").textContent = "📍 " + state.office.address;
        if (onDone) onDone();
        return;
      }
      // 도로명/지번 주소가 아니면 장소명으로 재시도
      places.keywordSearch(query, function (result2, status2) {
        if (status2 === kakao.maps.services.Status.OK && result2.length) {
          var p = result2[0];
          state.office = { lat: Number(p.y), lng: Number(p.x), address: p.road_address_name || p.address_name || p.place_name };
          $("#resolvedLoc").textContent = "📍 " + p.place_name + " · " + state.office.address;
          if (onDone) onDone();
        } else {
          $("#resolvedLoc").textContent = "";
          toast("위치를 찾지 못했어요. 정확한 주소나 건물명으로 다시 검색해주세요.");
        }
      });
    });
  }

  $("#locSearchBtn").addEventListener("click", function () {
    hideSuggestions();
    resolveOffice($("#locationInput").value, function () { toast("회사 위치를 확인했어요."); });
  });

  /* ---------- 회사 위치 자동완성 드롭다운 ---------- */
  var suggestBox = $("#locSuggestions");
  var locInput = $("#locationInput");
  var debounceTimer = null;

  function hideSuggestions() { suggestBox.hidden = true; suggestBox.innerHTML = ""; }

  function renderSuggestions(list) {
    if (!list.length) {
      suggestBox.innerHTML = '<div class="s-empty">검색 결과가 없어요</div>';
      suggestBox.hidden = false;
      return;
    }
    suggestBox.innerHTML = list.map(function (p, i) {
      return '<button type="button" data-idx="' + i + '">' +
        '<div class="s-name">' + p.place_name + '</div>' +
        '<div class="s-addr">' + (p.road_address_name || p.address_name || "") + '</div>' +
        '</button>';
    }).join("");
    suggestBox._items = list;
    suggestBox.hidden = false;
  }

  locInput.addEventListener("input", function () {
    var q = locInput.value.trim();
    clearTimeout(debounceTimer);
    if (!q || q.length < 2) { hideSuggestions(); return; }
    debounceTimer = setTimeout(function () {
      if (!kakaoReady) return;
      places.keywordSearch(q, function (result, status) {
        if (status === kakao.maps.services.Status.OK) renderSuggestions(result.slice(0, 6));
        else renderSuggestions([]);
      });
    }, 300);
  });

  suggestBox.addEventListener("mousedown", function (e) {
    // mousedown(전에) 선택해야 input의 blur보다 먼저 처리됨
    var btn = e.target.closest("button[data-idx]");
    if (!btn) return;
    var p = suggestBox._items[Number(btn.dataset.idx)];
    state.office = { lat: Number(p.y), lng: Number(p.x), address: p.road_address_name || p.address_name || p.place_name };
    locInput.value = p.place_name;
    $("#resolvedLoc").textContent = "📍 " + p.place_name + " · " + state.office.address;
    hideSuggestions();
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".loc-field")) hideSuggestions();
  });
  locInput.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hideSuggestions();
  });

  /* ---------- 식당 검색 ---------- */
  var CAT_FOOD = "FD6";
  var CAT_CAFE = "CE7";

  function runSearch(kind) {
    state.lastSearchKind = kind;
    if (!state.office) {
      resolveOffice($("#locationInput").value, function () { runSearch(kind); });
      return;
    }
    if (!kakaoReady) { toast("카카오맵을 불러오는 중이에요. 잠시 후 다시 시도해주세요."); return; }

    var loc = new kakao.maps.LatLng(state.office.lat, state.office.lng);
    var opts = { location: loc, radius: 1000, sort: kakao.maps.services.SortBy.DISTANCE };

    var anyCat = $("#chkAnyCat").checked;
    var category = $("#catSelect").value;

    var tasks = [];

    function wantFood() { return state.cafeSeg !== "only"; }
    function wantCafe() { return state.cafeSeg === "include" || state.cafeSeg === "only"; }

    if (kind === "soup") {
      tasks.push(searchOnce(function (cb) { places.keywordSearch("국물 맛집", cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
    } else if (kind === "cafe") {
      state.cafeSeg = "only"; syncCafeSegUI();
      tasks.push(searchOnce(function (cb) { places.categorySearch(CAT_CAFE, cb, opts); }));
    } else {
      if (wantFood()) {
        if (!anyCat) {
          tasks.push(searchOnce(function (cb) { places.keywordSearch(category + " 맛집", cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
        } else {
          tasks.push(searchOnce(function (cb) { places.categorySearch(CAT_FOOD, cb, opts); }));
        }
      }
      if (wantCafe()) {
        tasks.push(searchOnce(function (cb) { places.categorySearch(CAT_CAFE, cb, opts); }));
      }
    }

    $("#resultStatus").textContent = "검색 중이에요…";
    Promise.all(tasks).then(function (lists) {
      var merged = [].concat.apply([], lists);
      // 중복 제거 (같은 장소가 두 카테고리 모두에서 나올 수 있음)
      var seen = {};
      merged = merged.filter(function (p) { if (seen[p.id]) return false; seen[p.id] = true; return true; });
      merged.sort(function (a, b) { return Number(a.distance) - Number(b.distance); });
      openResultsModal(merged);
    });
  }

  function searchOnce(fn) {
    return new Promise(function (resolve) {
      fn(function (result, status) {
        if (status === kakao.maps.services.Status.OK) resolve(result);
        else resolve([]);
      });
    });
  }

  $("#searchBtn").addEventListener("click", function () { runSearch("default"); });
  $$(".tagchip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var tag = chip.dataset.quickTag;
      if (tag === "fav") { toast("즐겨찾기는 로그인 후 이용할 수 있어요 (준비 중)"); return; }
      if (tag === "fast") { runSearch("default"); return; }
      if (tag === "shuffle") { runSearch(state.lastSearchKind || "default"); return; }
      runSearch(tag);
    });
  });
  $("#menuLink").addEventListener("click", function () { toast("커뮤니티는 다음 업데이트에서 만나요"); });

  /* ---------- 인증 (Supabase Auth) ---------- */
  var authMode = "login";
  function renderAuth() {
    $("#authTitle").textContent = authMode === "login" ? "로그인" : "회원가입";
    $("#authSwitch").textContent = authMode === "login" ? "회원가입으로" : "로그인으로";
    $("#authSubmit").textContent = authMode === "login" ? "로그인" : "회원가입";
    $("#authNote").textContent = authMode === "signup" ? "가입 후 이메일로 오는 확인 링크를 눌러야 로그인할 수 있어요." : "";
  }
  $("#openLogin").addEventListener("click", function () {
    authMode = "login"; renderAuth();
    $("#authEmail").value = ""; $("#authPassword").value = "";
    $("#authModal").hidden = false;
  });
  $("#authSwitch").addEventListener("click", function () { authMode = authMode === "login" ? "signup" : "login"; renderAuth(); });
  $("#closeAuth").addEventListener("click", function () { $("#authModal").hidden = true; });
  $("#authModal").addEventListener("click", function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  $("#authSubmit").addEventListener("click", function () {
    if (!sb) { toast("로그인 서비스를 불러오지 못했어요."); return; }
    var email = $("#authEmail").value.trim();
    var password = $("#authPassword").value;
    if (!email || !password) { toast("이메일과 비밀번호를 입력해주세요."); return; }

    if (authMode === "signup") {
      sb.auth.signUp({ email: email, password: password }).then(function (res) {
        if (res.error) { toast(res.error.message); return; }
        toast("가입 요청을 보냈어요. 이메일을 확인해주세요.");
        $("#authModal").hidden = true;
      });
    } else {
      sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (res.error) { toast(res.error.message); return; }
        toast("로그인됐어요.");
        $("#authModal").hidden = true;
      });
    }
  });

  $("#logoutBtn").addEventListener("click", function () {
    if (!sb) return;
    sb.auth.signOut().then(function () { toast("로그아웃됐어요."); });
  });

  function updateAuthUI(user) {
    currentUser = user;
    $("#openLogin").hidden = !!user;
    $("#userChip").hidden = !user;
    if (user) $("#userEmail").textContent = user.email;
    $("#calendarLoggedOut").hidden = !!user;
    $("#calendarLoggedIn").hidden = !user;
    if (user) { fetchEntries(); }
  }

  if (sb) {
    sb.auth.getSession().then(function (res) { updateAuthUI(res.data.session ? res.data.session.user : null); });
    sb.auth.onAuthStateChange(function (_event, session) { updateAuthUI(session ? session.user : null); });
  }

  /* ---------- 캘린더 (식대·회식 기록) ---------- */
  $("#calendarLink").addEventListener("click", function () {
    $("#calendarModal").hidden = false;
    if (!currentUser) return;
    if (!$("#calDate").value) $("#calDate").value = new Date().toISOString().slice(0, 10);
  });
  $("#closeCalendar").addEventListener("click", function () { $("#calendarModal").hidden = true; });
  $("#calendarModal").addEventListener("click", function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  function fetchEntries() {
    if (!sb || !currentUser) return;
    sb.from("calendar_entries").select("*").order("entry_date", { ascending: false }).then(function (res) {
      if (res.error) { toast("불러오기 실패: " + res.error.message); return; }
      renderEntries(res.data || []);
      checkHangoverBanner(res.data || []);
    });
  }

  function renderEntries(list) {
    var el = $("#calList");
    if (!list.length) { el.innerHTML = '<div class="cal-empty">아직 기록이 없어요. 위에서 하나 추가해보세요.</div>'; return; }
    el.innerHTML = list.map(function (e) {
      return '<div class="cal-item">' +
        '<div class="c-main"><span class="c-date">' + e.entry_date + '</span><span class="c-type">' + e.entry_type + '</span>' +
        (e.memo ? '<div class="c-memo">' + e.memo + '</div>' : '') + '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
        (e.amount ? '<span class="c-amount">' + Number(e.amount).toLocaleString("ko-KR") + '원</span>' : '') +
        '<button class="c-del" data-del="' + e.id + '">삭제</button></div>' +
        '</div>';
    }).join("");
  }

  $("#calList").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-del]");
    if (!btn || !sb) return;
    sb.from("calendar_entries").delete().eq("id", btn.dataset.del).then(function (res) {
      if (res.error) { toast("삭제 실패: " + res.error.message); return; }
      fetchEntries();
    });
  });

  $("#calAddBtn").addEventListener("click", function () {
    if (!sb || !currentUser) return;
    var entry = {
      user_id: currentUser.id,
      entry_date: $("#calDate").value || new Date().toISOString().slice(0, 10),
      entry_type: $("#calType").value,
      amount: $("#calAmount").value ? Number($("#calAmount").value) : null,
      memo: $("#calMemo").value.trim() || null
    };
    sb.from("calendar_entries").insert(entry).then(function (res) {
      if (res.error) { toast("저장 실패: " + res.error.message); return; }
      $("#calAmount").value = ""; $("#calMemo").value = "";
      fetchEntries();
      toast("기록했어요.");
    });
  });

  function checkHangoverBanner(list) {
    var y = new Date(); y.setDate(y.getDate() - 1);
    var yStr = y.toISOString().slice(0, 10);
    var had = list.some(function (e) { return e.entry_type === "회식" && e.entry_date === yStr; });
    var banner = $("#hangoverBanner");
    if (had) {
      banner.hidden = false;
      banner.textContent = "🥣 어제 회식 기록이 있네요 — 오늘은 해장 메뉴 어때요?";
      banner.onclick = function () { runSearch("soup"); };
    } else {
      banner.hidden = true;
    }
  }

  /* ---------- 결과 모달 + 지도 ---------- */
  function syncCafeSegUI() {
    $$("#cafeSeg button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.seg === state.cafeSeg)); });
  }
  $$("#cafeSeg button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.cafeSeg = b.dataset.seg;
      syncCafeSegUI();
      runSearch(state.lastSearchKind || "default");
    });
  });

  function openResultsModal(list) {
    $("#resultsModal").hidden = false;
    renderMap(list);
    renderResultList(list);
  }
  $("#closeResults").addEventListener("click", function () { $("#resultsModal").hidden = true; });
  $("#resultsModal").addEventListener("click", function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  function renderMap(list) {
    var container = $("#kakaoMap");
    var center = new kakao.maps.LatLng(state.office.lat, state.office.lng);
    state.map = new kakao.maps.Map(container, { center: center, level: 5 });

    state.markers.forEach(function (m) { m.setMap(null); });
    state.markers = [];

    var officeMarker = new kakao.maps.Marker({
      position: center, map: state.map,
      image: new kakao.maps.MarkerImage(
        "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="10" fill="%2314181A" stroke="white" stroke-width="3"/></svg>'),
        new kakao.maps.Size(28, 28)
      )
    });
    state.markers.push(officeMarker);

    list.forEach(function (p) {
      var pos = new kakao.maps.LatLng(Number(p.y), Number(p.x));
      var marker = new kakao.maps.Marker({ position: pos, map: state.map });
      kakao.maps.event.addListener(marker, "click", function () { window.open(p.place_url, "_blank"); });
      state.markers.push(marker);
    });

    setTimeout(function () { state.map.relayout(); state.map.setCenter(center); }, 60);
  }

  function catShort(catName) {
    var parts = (catName || "").split(" > ");
    return parts[parts.length - 1] || catName || "";
  }

  function renderResultList(list) {
    var grid = $("#resultGrid");
    $("#resultStatus").textContent = state.office.address + " 기준 반경 1km · " + list.length + "곳 (카카오맵 실시간 데이터)";
    if (list.length === 0) {
      grid.innerHTML = '<div class="r-empty"><div class="big">🍽️</div>이 근처에서 조건에 맞는 곳을 찾지 못했어요.<br>다른 위치나 카테고리로 시도해보세요.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      var favored = state.favorites.has(p.id);
      var isCafe = p.category_group_code === "CE7";
      return '' +
        '<div class="r-card">' +
          '<div class="r-photo">' + (isCafe ? "☕" : "🍽️") +
            '<button class="fav-btn" data-fav="' + p.id + '" aria-pressed="' + favored + '" aria-label="즐겨찾기">' +
              '<svg viewBox="0 0 24 24" fill="' + (favored ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="2"><path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.1 1.4-6.3-4.8-4.3 6.4-.6z"/></svg>' +
            '</button>' +
            '<span class="b-dist">' + p.distance + 'm</span>' +
          '</div>' +
          '<div class="r-body">' +
            '<div class="r-name">' + p.place_name + '</div>' +
            '<div class="r-cat">' + catShort(p.category_name) + '</div>' +
            '<div class="r-addr">' + (p.road_address_name || p.address_name) + '</div>' +
            '<div class="r-phone">' + (p.phone ? "📞 " + p.phone : "전화번호 정보 없음") + '</div>' +
            '<a class="r-link-btn" href="' + p.place_url + '" target="_blank" rel="noopener">카카오맵에서 보기</a>' +
          '</div>' +
        '</div>';
    }).join("");
  }

  $("#resultGrid").addEventListener("click", function (e) {
    var favBtn = e.target.closest("[data-fav]");
    if (!favBtn) return;
    var id = favBtn.dataset.fav;
    if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
    favBtn.setAttribute("aria-pressed", state.favorites.has(id));
    favBtn.querySelector("svg").setAttribute("fill", state.favorites.has(id) ? "currentColor" : "none");
  });
})();
