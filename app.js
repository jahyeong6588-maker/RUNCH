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
    markers: [],
    searchMode: "meal",     // "meal" | "dinner"
    timeOfDay: "lunch",     // "lunch" | "evening"
    dinnerBudget: null,
    dinnerHeadcount: null,
    placeNotes: {},         // { placeId: { has_parking, has_room, hangover_menu, hours_note } } aggregated
    activeNotePlace: null   // 정보 추가 모달 대상
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
      useCurrentLocation({ silent: true });
    });
  }
  initKakao();

  /* ---------- 현재 위치 연동 ---------- */
  function shortAddr(addr) {
    var parts = (addr || "").split(" ");
    return parts.slice(0, 2).join(" ") || addr;
  }

  function useCurrentLocation(opts) {
    opts = opts || {};
    if (!navigator.geolocation) {
      if (!opts.silent) toast("이 브라우저는 위치 정보를 지원하지 않아요.");
      return;
    }
    if (!opts.silent) toast("현재 위치를 확인하는 중이에요…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      if (!kakaoReady) { if (!opts.silent) toast("카카오맵을 불러오는 중이에요. 잠시 후 다시 시도해주세요."); return; }
      geocoder.coord2Address(lng, lat, function (result, status) {
        var addr = "현재 위치";
        if (status === kakao.maps.services.Status.OK && result.length) {
          var r = result[0];
          addr = (r.road_address && r.road_address.address_name) || (r.address && r.address.address_name) || addr;
        }
        state.office = { lat: lat, lng: lng, address: addr };
        $("#locationInput").value = addr;
        $("#resolvedLoc").textContent = "📍 " + addr + " (현재 위치)";
        $("#headerLocText").textContent = shortAddr(addr);
        if (!opts.silent) toast("현재 위치로 설정했어요.");
      });
    }, function () {
      if (!opts.silent) toast("위치 권한이 없어서 현재 위치를 가져오지 못했어요. 브라우저 설정에서 위치 접근을 허용해주세요.");
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  $("#locPillBtn").addEventListener("click", function () { useCurrentLocation({ silent: false }); });

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

  /* ---------- 검색 모드 토글 (식사 / 회식) + 시간대 ---------- */
  $$("#searchModeSeg button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.searchMode = b.dataset.mode;
      $$("#searchModeSeg button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      var isDinner = state.searchMode === "dinner";
      $("#mealOnlyFields").hidden = isDinner;
      $("#dinnerOnlyFields").hidden = !isDinner;
      $$("#timeSeg button[data-seg='lunch']")[0].textContent = isDinner ? "점심 회식" : "점심식사";
      $$("#timeSeg button[data-seg='evening']")[0].textContent = isDinner ? "저녁 회식" : "저녁식사";
    });
  });
  $$("#timeSeg button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.timeOfDay = b.dataset.seg;
      $$("#timeSeg button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    });
  });
  $("#chkAnyCat").addEventListener("change", function () { $("#catSelect").disabled = $("#chkAnyCat").checked; });

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
    var wantHangover = $("#chkHangover").checked;

    var tasks = [];

    function wantFood() { return state.cafeSeg !== "only"; }
    function wantCafe() { return state.cafeSeg === "include" || state.cafeSeg === "only"; }

    if (kind === "soup") {
      tasks.push(searchOnce(function (cb) { places.keywordSearch("국물 맛집", cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
    } else if (kind === "cafe") {
      state.cafeSeg = "only"; syncCafeSegUI();
      tasks.push(searchOnce(function (cb) { places.categorySearch(CAT_CAFE, cb, opts); }));
    } else if (kind === "dinner") {
      var dinnerKw = (state.timeOfDay === "lunch" ? "점심 회식" : "저녁 회식") + " 맛집";
      tasks.push(searchOnce(function (cb) { places.keywordSearch(dinnerKw, cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
    } else {
      if (wantFood()) {
        if (!anyCat) {
          var timeWord = state.timeOfDay === "evening" ? " 저녁" : "";
          tasks.push(searchOnce(function (cb) { places.keywordSearch(category + timeWord + " 맛집", cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
        } else if (state.timeOfDay === "evening") {
          tasks.push(searchOnce(function (cb) { places.keywordSearch("저녁 맛집", cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
        } else {
          tasks.push(searchOnce(function (cb) { places.categorySearch(CAT_FOOD, cb, opts); }));
        }
      }
      if (wantCafe()) {
        tasks.push(searchOnce(function (cb) { places.categorySearch(CAT_CAFE, cb, opts); }));
      }
    }

    // 해장 필요 체크 시, 해장 관련 검색을 추가로 섞어줘요 (카카오 API는 메뉴 태그가 없어 키워드 기반 추천이에요)
    if (wantHangover && kind !== "soup") {
      tasks.push(searchOnce(function (cb) { places.keywordSearch("해장 국밥 짬뽕", cb, Object.assign({ category_group_code: CAT_FOOD }, opts)); }));
    }

    $("#resultStatus").textContent = "검색 중이에요…";
    Promise.all(tasks).then(function (lists) {
      var merged = [].concat.apply([], lists);
      // 중복 제거 (같은 장소가 두 카테고리 모두에서 나올 수 있음)
      var seen = {};
      merged = merged.filter(function (p) { if (seen[p.id]) return false; seen[p.id] = true; return true; });
      merged.sort(function (a, b) { return Number(a.distance) - Number(b.distance); });
      applyPlaceNotesAndOpen(merged);
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

  /* ---------- 크라우드소싱: 가게 정보 태그 (place_notes) ----------
     카카오 로컬 API는 영업시간·주차·룸 정보를 제공하지 않아서,
     RUNCH 이용자가 직접 태그한 데이터를 모아 필터링/뱃지에 사용해요. */
  function fetchPlaceNotes(placeIds, onDone) {
    if (!sb || !placeIds.length) { onDone({}); return; }
    sb.from("place_notes").select("*").in("place_id", placeIds).then(function (res) {
      var agg = {};
      if (!res.error && res.data) {
        res.data.forEach(function (row) {
          var a = agg[row.place_id] || { has_parking: false, has_room: false, hangover_menu: false, hours_note: null, _t: null };
          if (row.has_parking) a.has_parking = true;
          if (row.has_room) a.has_room = true;
          if (row.hangover_menu) a.hangover_menu = true;
          if (row.hours_note && (!a._t || (row.updated_at && row.updated_at > a._t))) {
            a.hours_note = row.hours_note;
            a._t = row.updated_at || a._t;
          }
          agg[row.place_id] = a;
        });
      }
      onDone(agg);
    }, function () { onDone({}); });
  }

  function applyPlaceNotesAndOpen(merged) {
    var ids = merged.map(function (p) { return p.id; });
    fetchPlaceNotes(ids, function (agg) {
      state.placeNotes = agg;
      var wantParking = $("#chkParking").checked;
      var wantRoom = $("#chkRoom").checked;
      var filtered = merged;
      if (wantParking) filtered = filtered.filter(function (p) { return agg[p.id] && agg[p.id].has_parking; });
      if (wantRoom) filtered = filtered.filter(function (p) { return agg[p.id] && agg[p.id].has_room; });
      state.filterEmptyByTag = (wantParking || wantRoom) && merged.length > 0 && filtered.length === 0;
      openResultsModal(filtered);
    });
  }

  $("#searchBtn").addEventListener("click", function () { runSearch(state.searchMode === "dinner" ? "dinner" : "default"); });
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

  /* ---------- 엑셀 배경 모드 (보스키) ----------
     런치 화면/기능은 그대로 두고, 배경과 상단 리본만 엑셀처럼 바꿔요. */
  function toggleExcelMode(force) {
    var on = (typeof force === "boolean") ? force : !document.body.classList.contains("excel-bg");
    document.body.classList.toggle("excel-bg", on);
  }
  $("#bossKeyBtn").addEventListener("click", function () { toggleExcelMode(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") toggleExcelMode();
  });

  /* ---------- 인증 (Supabase Auth) ---------- */
  var authMode = "login";
  function renderAuth() {
    $("#authTitle").textContent = authMode === "login" ? "로그인" : "회원가입";
    $("#authSwitch").textContent = authMode === "login" ? "회원가입으로" : "로그인으로";
    $("#authSubmit").textContent = authMode === "login" ? "로그인" : "회원가입";
    $("#authNote").textContent = "";
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
        toast("가입됐어요! 바로 이용할 수 있어요.");
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
    if (user) { checkHangoverBanner(); }
  }

  if (sb) {
    sb.auth.getSession().then(function (res) { updateAuthUI(res.data.session ? res.data.session.user : null); });
    sb.auth.onAuthStateChange(function (_event, session) { updateAuthUI(session ? session.user : null); });
  }

  /* ---------- 캘린더 (점심 기록 · 메모 · 상사 회식날) ---------- */
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtDate(y, m, d) { return y + "-" + pad2(m + 1) + "-" + pad2(d); } // m: 0-indexed
  function todayStr() { var t = new Date(); return fmtDate(t.getFullYear(), t.getMonth(), t.getDate()); }

  var calState = {
    year: null, month: null,          // 현재 보고 있는 달 (month: 0-indexed)
    selected: null,                    // 선택된 날짜 문자열
    daysMap: {}                        // { "YYYY-MM-DD": row }
  };

  $("#calendarLink").addEventListener("click", function () {
    $("#calendarModal").hidden = false;
    if (!currentUser) return;
    if (calState.year === null) {
      var t = new Date();
      calState.year = t.getFullYear();
      calState.month = t.getMonth();
      calState.selected = todayStr();
    }
    fetchCalendarMonth();
  });
  $("#closeCalendar").addEventListener("click", function () { $("#calendarModal").hidden = true; });
  $("#calendarModal").addEventListener("click", function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  $("#calPrevMonth").addEventListener("click", function () { shiftMonth(-1); });
  $("#calNextMonth").addEventListener("click", function () { shiftMonth(1); });
  function shiftMonth(delta) {
    var d = new Date(calState.year, calState.month + delta, 1);
    calState.year = d.getFullYear();
    calState.month = d.getMonth();
    fetchCalendarMonth();
  }

  function fetchCalendarMonth() {
    if (!sb || !currentUser) return;
    var y = calState.year, m = calState.month;
    var first = fmtDate(y, m, 1);
    var last = fmtDate(y, m, new Date(y, m + 1, 0).getDate());
    sb.from("calendar_days").select("*")
      .gte("entry_date", first).lte("entry_date", last)
      .then(function (res) {
        if (res.error) { toast("불러오기 실패: " + res.error.message); return; }
        calState.daysMap = {};
        (res.data || []).forEach(function (row) { calState.daysMap[row.entry_date] = row; });
        renderCalendarGrid();
        selectDate(calState.selected);
        updateCalTotal();
      });
  }

  function updateCalTotal() {
    var sum = 0;
    Object.keys(calState.daysMap).forEach(function (k) {
      var p = calState.daysMap[k].price;
      if (p) sum += Number(p);
    });
    $("#calTotalLabel").textContent = calState.year + "년 " + (calState.month + 1) + "월";
    $("#calTotal").textContent = sum.toLocaleString("ko-KR") + "원";
  }

  function renderCalendarGrid() {
    var y = calState.year, m = calState.month;
    $("#calMonthTitle").textContent = y + "년 " + (m + 1) + "월";
    var firstWeekday = new Date(y, m, 1).getDay();
    var numDays = new Date(y, m + 1, 0).getDate();
    var tStr = todayStr();

    var html = "";
    for (var i = 0; i < firstWeekday; i++) html += '<div class="cal-day is-blank"></div>';
    for (var d = 1; d <= numDays; d++) {
      var dateStr = fmtDate(y, m, d);
      var row = calState.daysMap[dateStr];
      var isToday = dateStr === tStr;
      var isSelected = dateStr === calState.selected;
      var dots = "";
      if (row) {
        if (row.restaurant_name) dots += '<span class="cal-dot dot-record"></span>';
        if (row.is_new) dots += '<span class="cal-dot dot-new"></span>';
        if (row.is_boss_dinner) dots += '<span class="cal-dot dot-boss"></span>';
      }
      html += '<button type="button" class="cal-day' + (isToday ? " is-today" : "") + (isSelected ? " is-selected" : "") + '" data-date="' + dateStr + '">' +
        '<span class="d-num">' + d + '</span>' +
        (isToday ? '<span class="d-today-label">오늘</span>' : '') +
        '<span class="d-dots">' + dots + '</span>' +
        '</button>';
    }
    $("#calGrid").innerHTML = html;
  }

  $("#calGrid").addEventListener("click", function (e) {
    var btn = e.target.closest(".cal-day:not(.is-blank)");
    if (!btn) return;
    selectDate(btn.dataset.date);
    $$(".cal-day").forEach(function (b) { b.classList.toggle("is-selected", b === btn); });
  });

  function selectDate(dateStr) {
    calState.selected = dateStr;
    var row = calState.daysMap[dateStr] || {};
    $("#calMemo").value = row.memo || "";
    $("#calRestaurant").value = row.restaurant_name || "";
    $("#calMenu").value = row.menu_name || "";
    $("#calPrice").value = row.price || "";
    $("#calIsNew").checked = !!row.is_new;
    var bossBtn = $("#bossDinnerBtn");
    bossBtn.classList.toggle("active", !!row.is_boss_dinner);
    bossBtn.textContent = row.is_boss_dinner ? "상사 회식날 해제" : "상사 회식날 등록";
  }

  $("#calMemoSaveBtn").addEventListener("click", function () {
    if (!sb || !currentUser || !calState.selected) return;
    sb.from("calendar_days").upsert({
      user_id: currentUser.id, entry_date: calState.selected, memo: $("#calMemo").value.trim() || null
    }, { onConflict: "user_id,entry_date" }).then(function (res) {
      if (res.error) { toast("저장 실패: " + res.error.message); return; }
      toast("메모를 저장했어요.");
      fetchCalendarMonth();
    });
  });

  $("#calRecordSaveBtn").addEventListener("click", function () {
    if (!sb || !currentUser || !calState.selected) return;
    var restaurant = $("#calRestaurant").value.trim();
    if (!restaurant) { toast("가게 상호명을 입력해주세요."); return; }
    sb.from("calendar_days").upsert({
      user_id: currentUser.id, entry_date: calState.selected,
      restaurant_name: restaurant,
      menu_name: $("#calMenu").value.trim() || null,
      price: $("#calPrice").value ? Number($("#calPrice").value) : null,
      is_new: $("#calIsNew").checked
    }, { onConflict: "user_id,entry_date" }).then(function (res) {
      if (res.error) { toast("저장 실패: " + res.error.message); return; }
      toast("점심 기록을 저장했어요.");
      fetchCalendarMonth();
    });
  });

  $("#bossDinnerBtn").addEventListener("click", function () {
    if (!sb || !currentUser || !calState.selected) return;
    var current = calState.daysMap[calState.selected];
    var next = !(current && current.is_boss_dinner);
    sb.from("calendar_days").upsert({
      user_id: currentUser.id, entry_date: calState.selected, is_boss_dinner: next
    }, { onConflict: "user_id,entry_date" }).then(function (res) {
      if (res.error) { toast("저장 실패: " + res.error.message); return; }
      toast(next ? "상사 회식날로 등록했어요." : "상사 회식날을 해제했어요.");
      fetchCalendarMonth();
      checkHangoverBanner();
    });
  });

  function checkHangoverBanner() {
    if (!sb || !currentUser) return;
    var y = new Date(); y.setDate(y.getDate() - 1);
    var yStr = fmtDate(y.getFullYear(), y.getMonth(), y.getDate());
    sb.from("calendar_days").select("is_boss_dinner").eq("entry_date", yStr).eq("is_boss_dinner", true).then(function (res) {
      var banner = $("#hangoverBanner");
      if (!res.error && res.data && res.data.length) {
        banner.hidden = false;
        banner.textContent = "🥣 어제 회식 기록이 있네요 — 오늘은 해장 메뉴 어때요?";
        banner.onclick = function () { runSearch("soup"); };
      } else {
        banner.hidden = true;
      }
    });
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

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function noteBadgesHtml(p) {
    var n = state.placeNotes[p.id];
    if (!n) return "";
    var b = "";
    if (n.has_parking) b += '<span class="r-badge">🅿️ 주차</span>';
    if (n.has_room) b += '<span class="r-badge">🚪 룸</span>';
    if (n.hangover_menu) b += '<span class="r-badge">🥣 해장</span>';
    if (!b) return "";
    return '<div class="r-badges">' + b + '</div>';
  }

  function hoursNoteHtml(p) {
    var n = state.placeNotes[p.id];
    if (!n || !n.hours_note) return "";
    return '<div class="r-hours-note">🕒 ' + escapeHtml(n.hours_note) + '</div>';
  }

  // 카카오 로컬 API는 장소 사진을 제공하지 않아서, 실제 썸네일 대신 카테고리별 아이콘으로 대체
  function catEmoji(catName) {
    var c = catName || "";
    if (c.indexOf("카페") > -1 || c.indexOf("디저트") > -1) return "☕";
    if (c.indexOf("술집") > -1 || c.indexOf("호프") > -1 || c.indexOf("포차") > -1) return "🍻";
    if (c.indexOf("고기") > -1 || c.indexOf("삼겹") > -1 || c.indexOf("갈비") > -1) return "🥩";
    if (c.indexOf("일식") > -1 || c.indexOf("초밥") > -1 || c.indexOf("돈까스") > -1) return "🍣";
    if (c.indexOf("중식") > -1) return "🥟";
    if (c.indexOf("양식") > -1 || c.indexOf("파스타") > -1 || c.indexOf("피자") > -1) return "🍝";
    if (c.indexOf("분식") > -1) return "🍢";
    if (c.indexOf("치킨") > -1) return "🍗";
    if (c.indexOf("국밥") > -1 || c.indexOf("찌개") > -1 || c.indexOf("탕") > -1 || c.indexOf("전골") > -1) return "🍲";
    if (c.indexOf("회") > -1 || c.indexOf("해물") > -1) return "🐟";
    return "🍽️";
  }

  function renderResultList(list) {
    var grid = $("#resultGrid");
    var statusMsg = state.office.address + " 기준 반경 1km · " + list.length + "곳 (카카오맵 실시간 데이터)";
    if (state.lastSearchKind === "dinner") {
      statusMsg += " · " + (state.dinnerTime === "lunch" ? "점심 회식" : "저녁 회식");
      if (state.dinnerBudget) statusMsg += " · 예산 " + state.dinnerBudget.toLocaleString("ko-KR") + "원 (참고용, 필터링 안 됨)";
    }
    $("#resultStatus").textContent = statusMsg;
    state.lastResultsList = list;
    state.lastResultsById = {};
    list.forEach(function (p) { state.lastResultsById[p.id] = p; });
    if (list.length === 0) {
      grid.innerHTML = state.filterEmptyByTag ?
        '<div class="r-empty"><div class="big">🏷️</div>아직 주차장·룸 정보가 태그된 가게가 없어요.<br>가까운 가게를 직접 태그하면 다른 동료들에게도 도움이 돼요!</div>' :
        '<div class="r-empty"><div class="big">🍽️</div>이 근처에서 조건에 맞는 곳을 찾지 못했어요.<br>다른 위치나 카테고리로 시도해보세요.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      var favored = state.favorites.has(p.id);
      return '' +
        '<div class="r-card">' +
          '<div class="r-photo">' + catEmoji(p.category_name) +
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
            noteBadgesHtml(p) +
            hoursNoteHtml(p) +
            '<div class="r-btn-row">' +
              '<a class="r-link-btn" href="' + p.place_url + '" target="_blank" rel="noopener">카카오맵에서 보기</a>' +
              '<button type="button" class="r-info-btn" data-note="' + p.id + '">📝 정보 추가</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }).join("");
  }

  $("#resultGrid").addEventListener("click", function (e) {
    var favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      var id = favBtn.dataset.fav;
      if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
      favBtn.setAttribute("aria-pressed", state.favorites.has(id));
      favBtn.querySelector("svg").setAttribute("fill", state.favorites.has(id) ? "currentColor" : "none");
      return;
    }
    var noteBtn = e.target.closest("[data-note]");
    if (noteBtn) {
      var pid = noteBtn.dataset.note;
      var place = state.lastResultsById[pid];
      if (place) openPlaceNoteModal(place);
      return;
    }
  });

  /* ---------- 가게 정보 추가 모달 (크라우드소싱 입력) ---------- */
  function openPlaceNoteModal(place) {
    if (!currentUser) {
      toast("정보 추가는 로그인 후 이용할 수 있어요.");
      authMode = "login"; renderAuth();
      $("#authEmail").value = ""; $("#authPassword").value = "";
      $("#authModal").hidden = false;
      return;
    }
    state.activeNotePlace = place;
    $("#placeNoteTarget").textContent = place.place_name + " · " + (place.road_address_name || place.address_name || "");
    var existing = state.placeNotes[place.id] || {};
    $("#pnParking").checked = !!existing.has_parking;
    $("#pnRoom").checked = !!existing.has_room;
    $("#pnHangover").checked = !!existing.hangover_menu;
    $("#pnHours").value = existing.hours_note || "";
    $("#placeNoteModal").hidden = false;
  }

  $("#closePlaceNote").addEventListener("click", function () { $("#placeNoteModal").hidden = true; });
  $("#placeNoteModal").addEventListener("click", function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

  $("#pnSaveBtn").addEventListener("click", function () {
    if (!sb || !currentUser || !state.activeNotePlace) { toast("정보 추가는 로그인 후 이용할 수 있어요."); return; }
    var place = state.activeNotePlace;
    var payload = {
      user_id: currentUser.id,
      place_id: place.id,
      place_name: place.place_name,
      has_parking: $("#pnParking").checked,
      has_room: $("#pnRoom").checked,
      hangover_menu: $("#pnHangover").checked,
      hours_note: $("#pnHours").value.trim() || null
    };
    sb.from("place_notes").upsert(payload, { onConflict: "place_id,user_id" }).then(function (res) {
      if (res.error) { toast("저장 실패: " + res.error.message); return; }
      toast("정보를 공유해주셔서 감사해요!");
      $("#placeNoteModal").hidden = true;
      var agg = state.placeNotes[place.id] || { has_parking: false, has_room: false, hangover_menu: false, hours_note: null };
      if (payload.has_parking) agg.has_parking = true;
      if (payload.has_room) agg.has_room = true;
      if (payload.hangover_menu) agg.hangover_menu = true;
      if (payload.hours_note) agg.hours_note = payload.hours_note;
      state.placeNotes[place.id] = agg;
      renderResultList(state.lastResultsList || []);
    });
  });
})();
