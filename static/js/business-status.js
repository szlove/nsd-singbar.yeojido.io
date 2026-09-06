/**
 * business-status.js
 *
 * 영업 상태 실시간 표시 — 클라이언트 사이드 계산.
 * 정적 사이트(Hugo/Next.js export) 빌드 시점이 아니라 방문 시점의 현재시각으로 계산해야 하므로 JS로 돈다.
 *
 * 지원 스키마 셋(오늘 실측, 사이트마다 혼재):
 *   1. { name, hours }        — 단일 구간 문자열 "HH:MM-HH:MM" 또는 "휴무"(휴무일)
 *   2. { name, range }        — 단일 구간 문자열 "HH:MM-HH:MM" (스키마 이름만 다르고 성격은 1과 같음)
 *   3. { name, part1, part2 } — 1부/2부 두 구간, 휴무일은 둘 다 빈 문자열 ""
 *
 * 요일 이름은 "월요일".."일요일" 접두어(예: "일요일 및 국가공휴일"도 "일요일"로 매칭)로 판별한다.
 *
 * 경계 규칙: [시작, 끝) 반열림 구간이다 — 끝 시각과 정확히 같은 순간은 "끝난 것"으로, 다음 구간의
 * 시작 시각과 같으면 "다음 구간이 시작된 것"으로 본다. 그래서 1부가 01:00에 끝나고 2부가 01:00에
 * 시작하면 정확히 01:00은 2부다.
 *
 * 이 파일은 사이트마다 값을 바꾸지 않는다 — 어느 사이트든 그대로 복사해 쓴다(공통 파서).
 */
(function () {
  "use strict";

  var DAY_PREFIX = ["일", "월", "화", "수", "목", "금", "토"]; // index == Date#getDay()

  function dayNameToIndex(name) {
    if (typeof name !== "string" || name.length === 0) return null;
    var ch = name.charAt(0);
    var idx = DAY_PREFIX.indexOf(ch);
    return idx === -1 ? null : idx;
  }

  function parseHM(hm) {
    var parts = hm.split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }

  function isBlank(v) {
    return typeof v !== "string" || v.trim() === "" || v.trim() === "휴무";
  }

  // day 객체 하나에서 스키마를 자동 판별해 순서 있는 구간 목록을 뽑는다.
  // 반환: [{start:"HH:MM", end:"HH:MM"}, ...] — 휴무면 빈 배열.
  function extractParts(day) {
    if (typeof day.hours === "string") {
      if (isBlank(day.hours)) return [];
      var hp = day.hours.split("-");
      return hp.length === 2 ? [{ start: hp[0], end: hp[1] }] : [];
    }
    if (typeof day.range === "string") {
      if (isBlank(day.range)) return [];
      var rp = day.range.split("-");
      return rp.length === 2 ? [{ start: rp[0], end: rp[1] }] : [];
    }
    var parts = [];
    ["part1", "part2"].forEach(function (key) {
      var v = day[key];
      if (typeof v === "string" && v.trim() !== "") {
        var pp = v.split("-");
        if (pp.length === 2) parts.push({ start: pp[0], end: pp[1] });
      }
    });
    return parts;
  }

  // baseDate(그 날짜의 00:00, 로컬시각) 기준으로 그 날 라벨의 구간들을 절대 Date로 바꾼다.
  // part2가 part1 끝보다 이르면(자정 넘김 연속) 다음 날짜로 민다 — 체이닝.
  // 반환: [{start:Date, end:Date, label:"1부"|"2부"|null}]
  function buildIntervalsForDate(baseDate, days) {
    var dow = baseDate.getDay();
    var day = null;
    for (var i = 0; i < days.length; i++) {
      if (dayNameToIndex(days[i].name) === dow) { day = days[i]; break; }
    }
    if (!day) return [];
    var parts = extractParts(day);
    var intervals = [];
    var cursor = null; // 이전 구간의 끝(Date)
    for (var j = 0; j < parts.length; j++) {
      var startMin = parseHM(parts[j].start);
      var endMin = parseHM(parts[j].end);
      if (startMin === null || endMin === null) continue;

      var start = new Date(baseDate.getTime());
      start.setMinutes(start.getMinutes() + startMin);
      if (cursor && start < cursor) {
        start = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      }

      var endBase = new Date(start.getTime());
      endBase.setHours(0, 0, 0, 0);
      var end = new Date(endBase.getTime());
      end.setMinutes(end.getMinutes() + endMin);
      if (end <= start) {
        end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      }

      var label = parts.length > 1 ? (j === 0 ? "1부" : "2부") : null;
      intervals.push({ start: start, end: end, label: label });
      cursor = end;
    }
    return intervals;
  }

  // days: hour.toml/hours.toml의 days 배열. now: Date(생략 시 현재시각).
  // 반환:
  //   { state:"open", label:"1부"|"2부"|null, endsAt:Date, nextPart:{label,start:Date}|null }
  //   { state:"before-open", nextStart:Date|null }
  //   { state:"unknown" } — days가 비었거나 판별 불가
  function computeStatus(days, now) {
    if (!days || days.length === 0) return { state: "unknown" };
    now = now || new Date();

    var candidates = [];
    for (var offset = -1; offset <= 2; offset++) {
      var d = new Date(now.getTime());
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + offset);
      var ivs = buildIntervalsForDate(d, days);
      for (var k = 0; k < ivs.length; k++) candidates.push(ivs[k]);
    }

    var openInterval = null;
    for (var a = 0; a < candidates.length; a++) {
      var iv = candidates[a];
      if (now >= iv.start && now < iv.end) { openInterval = iv; break; } // 먼저 등장한 구간 우선(겹침 타이브레이크)
    }

    if (openInterval) {
      var nextPart = null;
      for (var b = 0; b < candidates.length; b++) {
        var c = candidates[b];
        if (c.label && c.start.getTime() === openInterval.end.getTime() && c !== openInterval) {
          nextPart = c;
          break;
        }
      }
      return { state: "open", label: openInterval.label, endsAt: openInterval.end, nextPart: nextPart };
    }

    var next = null;
    for (var e = 0; e < candidates.length; e++) {
      var f = candidates[e];
      if (f.start > now && (!next || f.start < next.start)) next = f;
    }
    return { state: "before-open", nextStart: next ? next.start : null };
  }

  function formatRemaining(ms) {
    var totalMin = Math.round(ms / 60000);
    if (totalMin < 1) return "곧";
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h === 0) return m + "분 뒤";
    if (m === 0) return h + "시간 뒤";
    return h + "시간 " + m + "분 뒤";
  }

  // storeStatus: "운영중"|"폐업"(생략 시 "운영중"). days: hour.toml days 배열.
  // 반환: 화면에 그대로 넣을 문자열.
  function renderStatusText(storeStatus, days, now) {
    if (storeStatus === "폐업") return "폐업";

    var result = computeStatus(days, now || new Date());
    if (result.state === "unknown") return "";

    if (result.state === "open") {
      var text = "영업중";
      if (result.label) text += " · " + result.label;
      if (result.nextPart && result.nextPart.label) {
        var remain = result.nextPart.start.getTime() - (now || new Date()).getTime();
        // 다음 부 전환까지 12시간 이내일 때만 붙인다 — 그 이상이면 화면이 번잡해진다.
        if (remain > 0 && remain < 12 * 60 * 60 * 1000) {
          text += " · " + result.nextPart.label + "까지 " + formatRemaining(remain);
        }
      }
      return text;
    }

    // before-open
    if (!result.nextStart) return "오픈 전";
    var untilOpen = result.nextStart.getTime() - (now || new Date()).getTime();
    return "오픈 전 · " + formatRemaining(untilOpen);
  }

  window.BusinessStatus = {
    dayNameToIndex: dayNameToIndex,
    extractParts: extractParts,
    buildIntervalsForDate: buildIntervalsForDate,
    computeStatus: computeStatus,
    renderStatusText: renderStatusText
  };

  // DOM 자동 배선 — id="business-status-data"에 담긴 JSON({storeStatus, days})을 읽어
  // id="business-status-display" 요소의 텍스트를 채운다. 둘 중 하나라도 없으면 조용히 넘어간다
  // (JS가 꺼져 있거나 이 스크립트가 없어도 페이지는 그대로 정상 — 표시만 안 될 뿐).
  document.addEventListener("DOMContentLoaded", function () {
    var dataEl = document.getElementById("business-status-data");
    var displayEl = document.getElementById("business-status-display");
    if (!dataEl || !displayEl) return;
    try {
      var payload = JSON.parse(dataEl.textContent);
      var text = renderStatusText(payload.storeStatus, payload.days, new Date());
      if (text) displayEl.textContent = text;
    } catch (e) {
      // 파싱 실패 시 표시를 건드리지 않는다 — 기본 문구(빌드 시 넣어 둔 정적 텍스트) 유지.
    }
  });
})();
