// ────────────── helpers ──────────────

function refToApiPath(ref) {
  // "Genesis 1:1-2:3"  →  "Genesis.1.1-2.3"
  // "Deuteronomy 34:1-12" → "Deuteronomy.34.1-12"
  return ref.trim().replace(/\s+/g, ".").replace(/:/g, ".");
}

function flattenVerses(heField) {
  if (!heField) return [];
  if (typeof heField[0] === "string") return heField;
  // nested array (range spanning multiple refs)
  return heField.flat(Infinity);
}

// ────────────── Torah book table ──────────────

const torahBooks = [
  { he: "בראשית", api: "Genesis" },
  { he: "שמות", api: "Exodus" },
  { he: "ויקרא", api: "Leviticus" },
  { he: "במדבר", api: "Numbers" },
  { he: "דברים", api: "Deuteronomy" },
];

const LINES_PER_AMUD = 42;

const state = {
  chumashVisible: true,
  scrollMode: "plain",
  bookIndex: 0,
  amudIndex: 0,
  verses: [],
  lines: [],
  isLoading: false,
  error: "",
  parshaIndex: 0,
  aliyaRefs: [],
  aliyaIndex: 0,
  readingDate: new Date().toISOString().slice(0, 10),
  schedule: "diaspora",
  maftirSource: "",
};

const ranges = {
  nikkud: [
    [0x05b0, 0x05bc],
    [0x05bd, 0x05bd],
    [0x05bf, 0x05bf],
    [0x05c1, 0x05c2],
    [0x05c4, 0x05c5],
    [0x05c7, 0x05c7],
  ],
  trop: [[0x0591, 0x05af], [0x05c0, 0x05c0]],
};

const toggleButton = document.getElementById("toggleChumash");
const chumashHead = document.getElementById("chumashHead");
const chumashBody = document.getElementById("chumashBody");
const scrollBody = document.getElementById("scrollBody");
const panes = document.getElementById("panes");
const modeInputs = document.querySelectorAll('input[name="scrollMode"]');
const bookSelect = document.getElementById("bookSelect");
const prevAmudButton = document.getElementById("prevAmud");
const nextAmudButton = document.getElementById("nextAmud");
const statusLine = document.getElementById("statusLine");
const parshaSelect = document.getElementById("parshaSelect");
const aliyaSelect = document.getElementById("aliyaSelect");
const loadingSpinner = document.getElementById("loadingSpinner");
const readingDateInput = document.getElementById("readingDateInput");
const scheduleSelect = document.getElementById("scheduleSelect");

// ────────────── parsha / aliya ──────────────

const parshaAliyotCache = new Map();
const seferIndexCache = new Map();
const hebcalYearCache = new Map();
const parshaBookRanges = [
  [0, 11],
  [12, 22],
  [23, 32],
  [33, 42],
  [43, 53],
];

function getBookIndexForParsha(parshaIndex) {
  for (let index = 0; index < parshaBookRanges.length; index += 1) {
    const [start, end] = parshaBookRanges[index];
    if (parshaIndex >= start && parshaIndex <= end) {
      return index;
    }
  }

  return 0;
}

function getParshaIndicesForBook(bookIndex) {
  const [start, end] = parshaBookRanges[bookIndex];
  const indices = [];

  for (let index = start; index <= end; index += 1) {
    indices.push(index);
  }

  return indices;
}

function buildParshaOptionsForBook(bookIndex, selectedParshaIndex) {
  const visibleIndices = getParshaIndicesForBook(bookIndex);
  parshaSelect.innerHTML = "";

  visibleIndices.forEach((index) => {
    const { he } = PARSHAS[index];
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = he;
    parshaSelect.appendChild(opt);
  });

  const defaultIndex = visibleIndices[0];
  const finalIndex = visibleIndices.includes(selectedParshaIndex) ? selectedParshaIndex : defaultIndex;

  parshaSelect.value = String(finalIndex);
  state.parshaIndex = finalIndex;
}

function buildAliyaOptions(count) {
  aliyaSelect.innerHTML = "";
  const labels = ALIYA_LABELS.slice(0, count);
  labels.forEach((label, index) => {
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = `${index + 1} · ${label}`;
    aliyaSelect.appendChild(opt);
  });
}

function normalizeParshaKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/^parashat_/, "")
    .replace(/[\s_\-']/g, "");
}

function getStoredMaftirRef(parshaApiName) {
  if (typeof MAFTIR_DATA === "undefined" || !MAFTIR_DATA?.schemes) {
    return null;
  }

  const activeScheme = state.schedule || MAFTIR_DATA.activeScheme || "diaspora";
  const schemeMap = MAFTIR_DATA.schemes[activeScheme] || {};
  return schemeMap[parshaApiName] || null;
}

function normalizeHebrewParshaName(value) {
  return String(value)
    .replace(/^פרשת\s+/, "")
    .replace(/[\s־-]/g, "")
    .trim();
}

function sanitizeMaftirRef(value) {
  return String(value || "").split("|")[0].trim();
}

async function fetchHebcalParashotForYear(year, schedule) {
  const cacheKey = `${year}:${schedule}`;
  if (hebcalYearCache.has(cacheKey)) {
    return hebcalYearCache.get(cacheKey);
  }

  const israelFlag = schedule === "israel" ? "on" : "off";
  const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&year=${year}&yt=G&s=on&leyning=on&i=${israelFlag}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`שגיאה בטעינת לוח קריאה (${response.status})`);
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items.filter((item) => item.category === "parashat") : [];
  hebcalYearCache.set(cacheKey, items);
  return items;
}

async function getDateAwareMaftirRef(parshaIndex) {
  if (!state.readingDate) {
    return null;
  }

  const year = Number(state.readingDate.slice(0, 4));
  if (!Number.isFinite(year)) {
    return null;
  }

  const items = await fetchHebcalParashotForYear(year, state.schedule);
  const targetParshaName = normalizeHebrewParshaName(PARSHAS[parshaIndex].he);
  const candidates = items.filter((item) => normalizeHebrewParshaName(item.hebrew || "") === targetParshaName);

  if (candidates.length === 0) {
    return null;
  }

  const targetTime = Date.parse(state.readingDate);
  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const candidateTime = Date.parse(candidate.date);
    const distance = Number.isFinite(targetTime) && Number.isFinite(candidateTime)
      ? Math.abs(candidateTime - targetTime)
      : 0;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const maftir = sanitizeMaftirRef(best?.leyning?.maftir);
  return maftir || null;
}

async function resolveMaftirRef(parshaIndex) {
  try {
    const dateMaftir = await getDateAwareMaftirRef(parshaIndex);
    if (dateMaftir) {
      return { ref: dateMaftir, source: "hebcal-date" };
    }
  } catch {
  }

  const storedMaftir = getStoredMaftirRef(PARSHAS[parshaIndex].api);
  if (storedMaftir) {
    return { ref: storedMaftir, source: "stored-map" };
  }

  return { ref: null, source: "" };
}

async function fetchSeferParashaNodes(bookApi) {
  if (seferIndexCache.has(bookApi)) {
    return seferIndexCache.get(bookApi);
  }

  const url = `https://www.sefaria.org/api/index/${bookApi}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`שגיאה בטעינת ספר (${response.status})`);
  const data = await response.json();

  const nodes = data?.alts?.Parasha?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("לא נמצאו נתוני פרשיות לספר זה.");
  }

  seferIndexCache.set(bookApi, nodes);
  return nodes;
}

async function fetchAliyotForParsha(parshaIndex) {
  if (parshaAliyotCache.has(parshaIndex)) {
    const cached = parshaAliyotCache.get(parshaIndex);
    state.maftirSource = cached.maftirSource;
    return cached.refs;
  }

  const bookIndex = getBookIndexForParsha(parshaIndex);
  const bookApi = torahBooks[bookIndex].api;
  const nodes = await fetchSeferParashaNodes(bookApi);

  const targetKey = normalizeParshaKey(PARSHAS[parshaIndex].api);
  const match = nodes.find((node) => normalizeParshaKey(node.sharedTitle) === targetKey);

  if (!match || !Array.isArray(match.refs) || match.refs.length === 0) {
    throw new Error("לא נמצאו עליות לפרשה זו.");
  }

  const aliyahRefs = [...match.refs];
  const maftirResolution = await resolveMaftirRef(parshaIndex);
  let maftirSource = "";

  if (aliyahRefs.length === 7 && maftirResolution.ref) {
    aliyahRefs.push(maftirResolution.ref);
    maftirSource = maftirResolution.source;
  } else if (aliyahRefs.length === 7) {
    aliyahRefs.push(aliyahRefs[aliyahRefs.length - 1]);
    maftirSource = "fallback-shvii";
  }

  parshaAliyotCache.set(parshaIndex, { refs: aliyahRefs, maftirSource });
  state.maftirSource = maftirSource;
  return aliyahRefs;
}

async function loadAliyaText(ref) {
  const apiPath = refToApiPath(ref);
  const url = `https://www.sefaria.org/api/texts/${encodeURIComponent(apiPath)}?lang=he&commentary=0&context=0`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`שגיאה בטעינת עלייה (${response.status})`);
  const data = await response.json();
  const verses = flattenVerses(data.he).map(stripHtml).filter(Boolean);
  if (verses.length === 0) throw new Error("לא התקבלו פסוקים לעלייה זו.");
  return verses;
}

async function activateAliyaMode(parshaIndex, aliyaIndex) {
  state.bookIndex = getBookIndexForParsha(parshaIndex);
  state.parshaIndex = parshaIndex;
  state.isLoading = true;
  state.error = "";
  buildParshaOptionsForBook(state.bookIndex, parshaIndex);
  bookSelect.value = String(state.bookIndex);
  render();

  try {
    const refs = await fetchAliyotForParsha(parshaIndex);
    state.aliyaRefs = refs;

    const safeAliyaIndex = Math.min(Math.max(aliyaIndex, 0), refs.length - 1);
    state.aliyaIndex = safeAliyaIndex;

    buildAliyaOptions(refs.length);
    aliyaSelect.value = String(safeAliyaIndex);

    const verses = await loadAliyaText(refs[safeAliyaIndex]);
    state.verses = verses;
    state.amudIndex = 0;
    computeLines();
  } catch (err) {
    state.error = err instanceof Error ? err.message : "שגיאה בטעינת הפרשה.";
    state.verses = ["לא ניתן לטעון עלייה כרגע."];
    state.amudIndex = 0;
  } finally {
    state.isLoading = false;
    render();
  }
}

function isInRanges(codePoint, category) {
  const categoryRanges = ranges[category];
  return categoryRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function stripHtml(rawText) {
  const temp = document.createElement("div");
  temp.innerHTML = rawText;
  return (temp.textContent || "").trim();
}

function filterHebrewMarks(text, mode) {
  let output = "";

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    const isNikkud = isInRanges(codePoint, "nikkud");
    const isTrop = isInRanges(codePoint, "trop");

    if (mode === "plain" && (isNikkud || isTrop || codePoint === 0x05c3)) {
      continue;
    }

    if (mode === "trop" && isNikkud) {
      continue;
    }

    if (mode === "nikkud" && isTrop) {
      continue;
    }

    output += char;
  }

  return output;
}

function buildBookOptions() {
  bookSelect.innerHTML = "";
  torahBooks.forEach((book, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = book.he;
    bookSelect.appendChild(option);
  });
}

// ── Amud line-breaking ────────────────────────────────────────────────────

// Measurement span for scroll column — used only for line-breaking decisions (not word-spacing,
// which is now handled by CSS text-align-last:justify).
const _scrollMeasureSpan = (() => {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;" +
    "display:inline-block;white-space:nowrap;width:auto;height:auto;overflow:visible;" +
    "direction:rtl;" +
    "font-family:'SeferSTaM','Noto Rashi Hebrew','Frank Ruhl Libre','David Libre','Times New Roman',serif;" +
    "font-weight:700;letter-spacing:0.015em;font-size:clamp(1.5rem,2.5vw,2.25rem);";
  document.body.appendChild(el);
  return el;
})();

function measureStr(text) {
  if (!text) return 0;
  _scrollMeasureSpan.textContent = text;
  return _scrollMeasureSpan.getBoundingClientRect().width;
}

function getScrollColumnWidth() {
  const rect = scrollBody.getBoundingClientRect();
  if (rect.width > 0) return rect.width - 32;
  const pr = panes.getBoundingClientRect();
  if (pr.width > 0) return (pr.width - 16) / 2 - 32;
  return 450;
}

// Greedy line-breaker using full-string DOM measurement for every candidate line.
// Measuring the full candidate string is accurate because Hebrew letter widths vary
// greatly (ו ≈ half the width of מ) and full strings get correct font shaping.
// Word-spacing / justification is handled by CSS text-align-last:justify, not JS.
function breakVersesToLines(verses) {
  const maxWidth = getScrollColumnWidth();
  const allLines = [];

  // cwLine/swLine are shared across verse boundaries — in a real Sefer Torah,
  // words from consecutive verses share lines (no forced break at verse end).
  let cwLine = [], swLine = [];

  function flushLine(type) {
    if (cwLine.length === 0) return;
    allLines.push({ chumash: cwLine.join(" "), scroll: swLine.join(" "), type });
    cwLine = []; swLine = [];
  }

  for (const verse of verses) {
    // Split verse on parasha markers, keeping them as tokens
    const parts = verse.split(/(\{[פס]\})/);

    for (const part of parts) {
      const markerMatch = part.match(/^\{([פס])\}$/);
      if (markerMatch) {
        const type = markerMatch[1] === "פ" ? "petuchah" : "setumah";
        flushLine(type);
        if (type === "petuchah") {
          allLines.push({ chumash: "", scroll: "", type: "petuchah-spacer" });
        }
        continue;
      }

      const scrollPart = filterHebrewMarks(part, state.scrollMode);
      const cw = part.split(" ").filter(Boolean);
      const sw = scrollPart.split(" ").filter(Boolean);

      for (let i = 0; i < cw.length; i++) {
        const word = sw[i] || "";
        if (swLine.length === 0) {
          cwLine.push(cw[i]); swLine.push(word);
        } else {
          const candidate = swLine.join(" ") + " " + word;
          if (measureStr(candidate) <= maxWidth) {
            cwLine.push(cw[i]); swLine.push(word);
          } else {
            flushLine("normal");
            cwLine.push(cw[i]); swLine.push(word);
          }
        }
      }
    }
    // No flush here — words from the next verse continue on the same line
  }

  flushLine("normal"); // flush whatever remains after the last verse
  return allLines;
}

function computeLines() {
  state.lines = state.verses.length > 0 ? breakVersesToLines(state.verses) : [];
}

function totalAmudim() {
  return Math.max(1, Math.ceil(state.lines.length / LINES_PER_AMUD));
}

function updateStatus() {
  if (state.isLoading) { statusLine.textContent = "טוען..."; return; }
  if (state.error)      { statusLine.textContent = state.error; return; }

  const parsha = PARSHAS[state.parshaIndex];
  const aliyaLabel = ALIYA_LABELS[state.aliyaIndex] || `${state.aliyaIndex + 1}`;
  const maftirSourceText = state.maftirSource === "hebcal-date"
    ? "Hebcal"
    : state.maftirSource === "stored-map"
      ? "Stored"
      : state.maftirSource === "fallback-shvii"
        ? "Fallback"
        : "";
  const isMaftirSelected = aliyaLabel === "מפטיר";
  const sourceSegment = isMaftirSelected && maftirSourceText ? ` · מקור מפטיר: ${maftirSourceText}` : "";
  const total = totalAmudim();

  statusLine.textContent = `פרשת ${parsha.he} · עלייה ${aliyaLabel}${total > 1 ? ` · עמוד ${state.amudIndex + 1}/${total}` : ""}${sourceSegment}`;
}

function updateNavButtons() {
  const total = totalAmudim();

  const hasPrevAmud = state.amudIndex > 0;
  const hasNextAmud = state.amudIndex < total - 1;
  const hasPrevAliya = state.aliyaIndex > 0 || state.parshaIndex > 0;
  const hasNextAliya = state.aliyaIndex < state.aliyaRefs.length - 1 || state.parshaIndex < PARSHAS.length - 1;

  prevAmudButton.disabled = state.isLoading || (!hasPrevAmud && !hasPrevAliya);
  nextAmudButton.disabled = state.isLoading || (!hasNextAmud && !hasNextAliya);

  bookSelect.disabled = state.isLoading;
}

function render() {
  if (!state.isLoading && state.verses.length > 0 && state.lines.length === 0) {
    computeLines();
  }

  const startLine = state.amudIndex * LINES_PER_AMUD;
  const currentLines = state.lines.slice(startLine, startLine + LINES_PER_AMUD);

  chumashBody.innerHTML = "";
  scrollBody.innerHTML = "";

  currentLines.forEach(({ chumash, scroll, type }) => {
    if (type === "petuchah-spacer") {
      chumashBody.appendChild(Object.assign(document.createElement("div"), { className: "petuchah-spacer" }));
      scrollBody.appendChild(Object.assign(document.createElement("div"), { className: "petuchah-spacer" }));
      return;
    }

    // CSS text-align-last:justify handles filling; add type as class so petuchah/setumah
    // lines get text-align-last:right (intentionally short) via stylesheet.
    const lineClass = type === "normal" ? "text-line" : `text-line ${type}`;

    const cd = document.createElement("div");
    cd.className = lineClass;
    if (type === "petuchah" || type === "setumah") {
      const marker = type === "petuchah" ? "פ" : "ס";
      cd.textContent = chumash + " ";
      const span = document.createElement("span");
      span.className = "parsha-marker";
      span.textContent = `{${marker}}`;
      cd.appendChild(span);
    } else {
      cd.textContent = chumash;
    }
    chumashBody.appendChild(cd);

    const sd = document.createElement("div");
    sd.className = lineClass;
    sd.textContent = scroll;
    scrollBody.appendChild(sd);
  });

  if (state.chumashVisible) {
    chumashHead.hidden = false;
    chumashBody.hidden = false;
    panes.classList.add("two-up");
    panes.classList.remove("single");
    toggleButton.textContent = "הסתר חומש";
    toggleButton.setAttribute("aria-pressed", "true");
  } else {
    chumashHead.hidden = true;
    chumashBody.hidden = true;
    panes.classList.remove("two-up");
    panes.classList.add("single");
    toggleButton.textContent = "הצג חומש";
    toggleButton.setAttribute("aria-pressed", "false");
  }

  bookSelect.value = String(state.bookIndex);
  readingDateInput.value = state.readingDate;
  scheduleSelect.value = state.schedule;
  loadingSpinner.hidden = !state.isLoading;

  updateNavButtons();
  updateStatus();
}

async function goToPreviousAmud() {
  if (state.amudIndex > 0) {
    state.amudIndex -= 1;
    render();
    return;
  }

  const prevAliya = state.aliyaIndex - 1;
  if (prevAliya >= 0) {
    aliyaSelect.value = String(prevAliya);
    await activateAliyaMode(state.parshaIndex, prevAliya);
  } else {
    const prevParsha = state.parshaIndex - 1;
    if (prevParsha >= 0) {
      parshaSelect.value = String(prevParsha);
      aliyaSelect.innerHTML = "<option>טוען...</option>";
      const refs = await fetchAliyotForParsha(prevParsha);
      await activateAliyaMode(prevParsha, refs.length - 1);
    }
  }
}

async function goToNextAmud() {
  if (state.amudIndex < totalAmudim() - 1) {
    state.amudIndex += 1;
    render();
    return;
  }

  const nextAliya = state.aliyaIndex + 1;
  if (nextAliya < state.aliyaRefs.length) {
    aliyaSelect.value = String(nextAliya);
    await activateAliyaMode(state.parshaIndex, nextAliya);
  } else {
    const nextParsha = state.parshaIndex + 1;
    if (nextParsha < PARSHAS.length) {
      parshaSelect.value = String(nextParsha);
      aliyaSelect.innerHTML = "<option>טוען...</option>";
      await activateAliyaMode(nextParsha, 0);
    }
  }
}

toggleButton.addEventListener("click", () => {
  state.chumashVisible = !state.chumashVisible;
  render();
});

modeInputs.forEach((input) => {
  input.addEventListener("change", (event) => {
    state.scrollMode = event.target.value;
    computeLines();
    render();
  });
});

parshaSelect.addEventListener("change", async (event) => {
  const parshaIndex = Number(event.target.value);
  const parshaBookIndex = getBookIndexForParsha(parshaIndex);

  if (state.bookIndex !== parshaBookIndex) {
    state.bookIndex = parshaBookIndex;
    bookSelect.value = String(state.bookIndex);
    buildParshaOptionsForBook(state.bookIndex, parshaIndex);
  }

  aliyaSelect.innerHTML = "<option>טוען...</option>";
  await activateAliyaMode(parshaIndex, 0);
});

async function refreshCurrentAliyaForMaftirSettings() {
  parshaAliyotCache.clear();
  await activateAliyaMode(state.parshaIndex, state.aliyaIndex);
}

readingDateInput.addEventListener("change", async (event) => {
  state.readingDate = event.target.value;
  await refreshCurrentAliyaForMaftirSettings();
});

scheduleSelect.addEventListener("change", async (event) => {
  state.schedule = event.target.value;
  hebcalYearCache.clear();
  await refreshCurrentAliyaForMaftirSettings();
});

aliyaSelect.addEventListener("change", async (event) => {
  const aliyaIndex = Number(event.target.value);
  await activateAliyaMode(state.parshaIndex, aliyaIndex);
});

bookSelect.addEventListener("change", async (event) => {
  state.bookIndex = Number(event.target.value);
  buildParshaOptionsForBook(state.bookIndex);
  const selectedParshaIndex = Number(parshaSelect.value);
  aliyaSelect.innerHTML = "<option>טוען...</option>";
  await activateAliyaMode(selectedParshaIndex, 0);
});

prevAmudButton.addEventListener("click", async () => {
  await goToPreviousAmud();
});

nextAmudButton.addEventListener("click", async () => {
  await goToNextAmud();
});

buildBookOptions();
buildParshaOptionsForBook(state.bookIndex);
buildAliyaOptions(8);   // placeholder until a parsha is loaded
activateAliyaMode(state.parshaIndex, 0);

// Recompute line-breaks after fonts load (SeferSTaM may not be ready on first render)
document.fonts.ready.then(() => {
  if (state.verses.length > 0) { computeLines(); render(); }
});

// Recompute on resize (column width changes)
let _resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (state.verses.length > 0) { computeLines(); render(); }
  }, 200);
});
