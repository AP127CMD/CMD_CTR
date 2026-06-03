// AUTO SLOT FINDER — auto-rank AP-127 SPs and find the best slot for each.
const { useMemo: useM_asf, useState: useS_asf, useEffect: useE_asf, useRef: useR_asf, useCallback: useC_asf } = React;

const ASF_CACHE_URL      = 'https://ap127cmd.github.io/DB001/cache.json';
const ASF_CACHE_FALLBACK = 'https://raw.githubusercontent.com/AP127CMD/DB001/main/cache.json';

// ─── FI lookup (short code → full name used in FLIGHTS) ──────────────────
const ASF_FI_FULL = {
  "W-CHAI":"WUTTHICHAI L.", "P-YUTH":"PHAHOLYUTH P.", "P-YA":"PARINYA B.",
  "S-TI":"SANTI SUK.",      "N-TORN":"NAPATTORN S.",   "I-POL":"ITTIPOL P.",
  "SN-TI":"SANTI PO.",      "A-WAT":"THAWATANAN P.",   "W-NU":"WISANU T.",
  "K-POL":"KOONPHOL U.",    "C-CHAI":"CHAROENCHAI U.", "E-PHOB":"EKKAPHOP R.",
  "S-WAN":"SOWAN C.",       "K-CHAI":"KITTICHAI C.",
};

// "DA40-TDI" → "DA40TDI" (match RESOURCES acType)
const asfNormSe = se => se ? se.replace(/-/g, '') : null;

function asfShortName(fullName) {
  if (!fullName) return '';
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function asfDateDiff(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
}

function asfIdleDays(student, refDate) {
  const flown = student?.flown || [];
  if (!flown.length) return null;
  let last = null;
  for (const f of flown) { if (f?.date && (!last || f.date > last)) last = f.date; }
  if (!last) return null;
  const d = asfDateDiff(refDate, last);
  return d == null ? null : Math.max(0, d);
}

function asfRankClass(rank, total) {
  if (rank <= 3) return 'bad';
  if (rank <= Math.ceil(total * 0.4)) return 'mid';
  return 'ok';
}

function asfBehindSort(arr, refDate) {
  return [...arr].sort((a, b) =>
    (a.done || 0) - (b.done || 0) ||
    (asfIdleDays(b, refDate) ?? 0) - (asfIdleDays(a, refDate) ?? 0));
}
function asfPaceSort(arr, refDate) {
  return [...arr].sort((a, b) =>
    (b.done || 0) - (a.done || 0) ||
    (asfIdleDays(a, refDate) ?? 0) - (asfIdleDays(b, refDate) ?? 0));
}
function asfIdleSort(arr, refDate) {
  return [...arr].sort((a, b) =>
    (asfIdleDays(b, refDate) ?? -1) - (asfIdleDays(a, refDate) ?? -1) ||
    (a.done || 0) - (b.done || 0));
}

// ─── Cache feed ───────────────────────────────────────────────────────────
const ASF_LS_KEY     = 'ap127-rank-cache-v1';
const ASF_LS_MAX_AGE = 6 * 60 * 60 * 1000;

async function asfFetchRank() {
  for (const url of [ASF_CACHE_URL, ASF_CACHE_FALLBACK]) {
    try {
      const r = await fetch(url + '?ts=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) continue;
      const data = await r.json();
      if (data && Array.isArray(data.ap127)) {
        const payload = { ap127: data.ap127, _updated: data._updated, _fetchedAt: Date.now(), _src: url };
        try { localStorage.setItem(ASF_LS_KEY, JSON.stringify(payload)); } catch (_) {}
        return payload;
      }
    } catch (_) {}
  }
  throw new Error('Could not fetch AP127 rank data');
}

function asfLoadCached() {
  try {
    const raw = localStorage.getItem(ASF_LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return (p && Array.isArray(p.ap127)) ? p : null;
  } catch (_) { return null; }
}

// ─── Option arrays ────────────────────────────────────────────────────────
const ASF_DUR_OPTS = (() => {
  const o = [];
  for (let m = 45; m <= 300; m += 15)
    o.push({ v: m, l: `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}` });
  return o;
})();

const ASF_GAP_OPTS = (() => {
  const o = [];
  for (let m = 0; m <= 60; m += 5)
    o.push({ v: m, l: m === 0 ? 'No buffer' : `${m} min` });
  return o;
})();

const ASF_TOPN_OPTS = [3, 5, 8, 12, 20, 28].map(n => ({ v: n, l: `Top ${n}` }));

const ASF_HOUR_START = 6;
const ASF_HOUR_END   = 18;
const ASF_HOUR_SPAN  = ASF_HOUR_END - ASF_HOUR_START;
const ASF_MAX_DUTY   = 420;

// ─── User settings persistence ────────────────────────────────────────────
// Versioned localStorage key — bump v1→v2 if the saved schema changes.
// (Distinct from ASF_LS_KEY above, which stores the NGT SP rank cache.)
const ASF_SETTINGS_LS_KEY = 'ap127-asf-settings-v1';
const ASF_DEFAULTS = {
  acTypeFilter: null,   // null=ALL, []=NONE, string[]=subset
  fiFilter:     null,
  fiMatchSp:    true,
  windowFrom:   '06:30',
  windowTo:     '18:00',
  rwyEnabled:   true,
  rwyFrom:      '14:00',
  rwyTo:        '16:00',
  sortMode:     'behind',
  topN:         8,
  onlyOpen:     false,
};
const asfLoadSettings = () => {
  try { return { ...ASF_DEFAULTS, ...JSON.parse(localStorage.getItem(ASF_SETTINGS_LS_KEY) || '{}') }; }
  catch { return { ...ASF_DEFAULTS }; }
};

const asfMinsToHHMM = m =>
  m == null ? '—' : `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

const asfFmtDur = m => { const h = Math.floor(m/60), mm = m%60; return mm ? `${h}h ${mm}m` : `${h}h`; };

function asfHasOverlap(blocks, t, end) {
  if (!blocks?.length) return false;
  for (let i = 0; i < blocks.length; i++)
    if (t < blocks[i].end && end > blocks[i].start) return true;
  return false;
}

function asfDutyOk(duty, t, end) {
  if (!duty) return true;
  return (Math.max(duty.last, end) - Math.min(duty.first, t)) <= ASF_MAX_DUTY;
}

function asfBuildBusyMap(flights, gapMin) {
  // Build the full set of known FI names from every flight in this call's flight list,
  // then union with SF_AP127_FI_NAMES (AP-127 specific FIs).
  // This detects ANY flight where a person who also appears as an instructor
  // (in any batch — FAM FI, PPC, Recurrent…) is listed as a student, so their
  // time is correctly blocked in fiBusy.
  const _allInstructors = new Set(flights.map(f => f.instructor).filter(Boolean));
  const _fiSet = new Set([
    ..._allInstructors,
    ...(typeof SF_AP127_FI_NAMES !== 'undefined' ? SF_AP127_FI_NAMES : []),
  ]);

  const rawFI = {}, rawSP = {}, rawTail = {}, fiDuty = {};
  flights.forEach(f => {
    const s = minutesOf(f.start), e = minutesOf(f.end);
    if (s == null || e == null) return;
    // Include full flight object so the timeline can show clickable detail
    const push = (map, key) => { if (key) (map[key] = map[key] || []).push({ s, e, flight: f }); };
    push(rawFI, f.instructor); push(rawSP, f.student); push(rawTail, f.tail);
    // If an FI appears as the student (e.g. FAM FI, PPC check), block their FI time too
    if (f.student && _fiSet.has(f.student)) push(rawFI, f.student);
    const trackDuty = (name) => {
      if (!name) return;
      const d = fiDuty[name];
      if (!d) fiDuty[name] = { first: s, last: e };
      else { d.first = Math.min(d.first, s); d.last = Math.max(d.last, e); }
    };
    trackDuty(f.instructor);
    if (f.student && _fiSet.has(f.student)) trackDuty(f.student);
  });
  const toBusy = rawMap => {
    const out = {};
    Object.entries(rawMap).forEach(([key, arr]) => {
      out[key] = arr.map(({ s, e }) => ({ start: s - gapMin, end: e + gapMin }));
    });
    return out;
  };
  return { fiBusy: toBusy(rawFI), spBusy: toBusy(rawSP), tailBusy: toBusy(rawTail), fiDuty, rawFI, rawSP, rawTail };
}

function asfFindSlotsForStudent(spName, { windowStart, windowEnd, durationMin, rwyStart, rwyEnd }, { fiBusy, spBusy, tailBusy, fiDuty }, { candFIs, candTails, tailTypeMap, fiQuals }) {
  const results = [];
  for (let t = windowStart; t <= windowEnd - durationMin; t += 15) {
    const end = t + durationMin;
    if (rwyStart != null && rwyEnd != null && t < rwyEnd && end > rwyStart) continue;
    if (asfHasOverlap(spBusy[spName], t, end)) continue;
    const freeFIs   = candFIs.filter(fi => !asfHasOverlap(fiBusy[fi], t, end) && asfDutyOk(fiDuty[fi], t, end));
    const freeTails = candTails.filter(tail => !asfHasOverlap(tailBusy[tail], t, end));
    if (!freeFIs.length || !freeTails.length) continue;
    const pairs = [];
    for (const fi of freeFIs) {
      const quals = fiQuals[fi] || [];
      for (const tail of freeTails)
        if (quals.includes(tailTypeMap[tail])) pairs.push({ fi, tail });
    }
    if (!pairs.length) continue;
    results.push({ t, end, pairs });
  }
  return results;
}

function asfMergeSlots(rawSlots) {
  if (!rawSlots.length) return [];
  const makeKey = slot => {
    const fis = [...new Set(slot.pairs.map(p => p.fi))].sort().join('|');
    const tls = [...new Set(slot.pairs.map(p => p.tail))].sort().join('|');
    return `${fis}##${tls}`;
  };
  const windows = [];
  let cur = null;
  rawSlots.forEach(slot => {
    const key = makeKey(slot);
    if (cur && cur._key === key && slot.t === cur.end) { cur.end = slot.end; }
    else { if (cur) windows.push(cur); cur = { ...slot, _key: key }; }
  });
  if (cur) windows.push(cur);
  return windows.map(({ _key, ...w }) => w);
}

// Effective overrides: FI/SE from student.fi/student.se (from NGT cache), with fallback to last FLIGHTS entry
function asfGetOverride(spKey, student, spOverrides) {
  const ovr = spOverrides[spKey];
  const defaultDur = (() => {
    if (!student?.planned?.length || !student?.next_lesson) return 60;
    const p = student.planned.find(x => x.lesson === student.next_lesson);
    return p?.mins ? Math.ceil(p.mins / 15) * 15 : 60;
  })();
  const defaultFI = (() => {
    if (student?.fi) return ASF_FI_FULL[student.fi] || student.fi;
    for (let i = FLIGHTS.length - 1; i >= 0; i--) {
      const f = FLIGHTS[i];
      if (f.student === spKey && f.status !== 'Canceled' && f.instructor) return f.instructor;
    }
    return 'Any';
  })();
  const defaultSeType = (() => {
    if (student?.se) return asfNormSe(student.se) || 'Any';
    for (let i = FLIGHTS.length - 1; i >= 0; i--) {
      const f = FLIGHTS[i];
      if (f.student === spKey && f.status !== 'Canceled' && f.tail) {
        const res = RESOURCES.find(r => r.tail === f.tail);
        return res?.acType || 'Any';
      }
    }
    return 'Any';
  })();
  return {
    fi:       (ovr && ovr.fi       != null) ? ovr.fi       : defaultFI,
    seType:   (ovr && ovr.seType   != null) ? ovr.seType   : defaultSeType,
    duration: (ovr && ovr.duration != null) ? ovr.duration : defaultDur,
    gap:      (ovr && ovr.gap      != null) ? ovr.gap      : 30,
  };
}

// ─── AsfSel (simple select — used for DATE and SHOW) ─────────────────────
function AsfSel({ label, value, onChange, opts, minWidth, accent }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:3 }}>
      <span className="mono uc" style={{ fontSize:9, color: accent || 'var(--ink-3)' }}>{label}</span>
      <select className="mono" value={value} onChange={e => onChange(e.target.value)}
        style={{ background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)', borderRadius:4, padding:'4px 8px', fontSize:11, outline:'none', minWidth: minWidth || 90, height:28 }}>
        {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

// ─── AsfTimePicker (button + floating hour:min popup) ─────────────────────
function AsfTimePicker({ label, value, onChange, accent }) {
  const [open, setOpen] = useS_asf(false);
  const [panelPos, setPanelPos] = useS_asf({ top: 0, left: 0 });
  const btnRef  = useR_asf(null);
  const panelRef = useR_asf(null);

  const parts = (value || '06:00').split(':');
  const h = parseInt(parts[0]) || 6;
  const rawM = parseInt(parts[1]) || 0;
  const m = Math.round(rawM / 15) * 15 % 60;

  const hours = Array.from({ length: 13 }, (_, i) => i + 6); // 6..18
  const mins  = [0, 15, 30, 45];

  const setH = newH => onChange(`${String(newH).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  const setM = newM => onChange(`${String(h).padStart(2,'0')}:${String(newM).padStart(2,'0')}`);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPanelPos({ top: r.bottom + 2, left: r.left });
    }
    setOpen(v => !v);
  };

  useE_asf(() => {
    if (!open) return;
    const close = e => {
      if (!btnRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const ac = accent ? `color-mix(in oklch,${accent} 40%,var(--line))` : open ? 'color-mix(in oklch,var(--col-pending) 60%,var(--line))' : 'var(--line)';

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
      {label && <span className="mono uc" style={{ fontSize:9, color: accent || 'var(--ink-3)' }}>{label}</span>}
      <button ref={btnRef} onClick={handleToggle} className="mono num"
        style={{ height:28, width:72, padding:'0 8px', borderRadius:4, cursor:'pointer',
          border:`1px solid ${ac}`,
          background: open ? 'color-mix(in oklch,var(--col-pending) 6%,var(--surface))' : 'var(--surface)',
          color:'var(--ink)', fontFamily:'inherit', fontSize:11, textAlign:'center',
        }}>
        {value}
      </button>
      {open && (
        <div ref={panelRef} style={{
          position:'fixed', top: panelPos.top, left: panelPos.left, zIndex:400,
          background:'var(--bg-2)', borderRadius:6, border:'1px solid var(--line)',
          boxShadow:'0 6px 24px oklch(0 0 0 / 0.45)',
          padding:'8px', display:'flex', gap:6, alignItems:'center',
        }}>
          <select value={h} onChange={e => setH(+e.target.value)} className="mono num"
            style={{ background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)', borderRadius:4, padding:'3px 4px', fontSize:12, height:30, width:54, outline:'none' }}>
            {hours.map(hh => <option key={hh} value={hh}>{String(hh).padStart(2,'0')}</option>)}
          </select>
          <span className="mono" style={{ fontSize:15, color:'var(--ink-3)', userSelect:'none' }}>:</span>
          <select value={m} onChange={e => setM(+e.target.value)} className="mono num"
            style={{ background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)', borderRadius:4, padding:'3px 4px', fontSize:12, height:30, width:54, outline:'none' }}>
            {mins.map(mm => <option key={mm} value={mm}>{String(mm).padStart(2,'0')}</option>)}
          </select>
          <button onClick={() => setOpen(false)} className="mono"
            style={{ height:30, padding:'0 9px', borderRadius:4, cursor:'pointer',
              background:'color-mix(in oklch,var(--col-done) 14%,transparent)',
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 45%,transparent)',
              color:'var(--col-done)', fontSize:11, fontWeight:600 }}>✓</button>
        </div>
      )}
    </div>
  );
}

// ─── AsfInlineSel (per-SP filter row) ─────────────────────────────────────
function AsfInlineSel({ label, value, onChange, opts }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:2 }}>
      <span className="mono uc" style={{ fontSize:7, color:'var(--ink-3)' }}>{label}</span>
      <select className="mono" value={value} onChange={e => onChange(e.target.value)}
        style={{ background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)', borderRadius:3, padding:'2px 4px', fontSize:10, outline:'none', height:22, minWidth:0 }}>
        {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

// ─── AsfMultiCheck (mirrors SfMultiCheck from view-slotfinder.js exactly) ─
// items: [{v, l}]  selected: string[]  onChange: (string[]) => void
// empty selected = all shown (same convention as SlotFinder's SfMultiCheck)
// selected model: null = ALL (all items pass), [] = NONE (nothing passes), string[] = explicit subset
function AsfMultiCheck({ label, items, selected, onChange, allLabel, color }) {
  const [open, setOpen] = useS_asf(false);
  const ac = color || 'var(--col-pending)';
  const isAll  = selected === null;
  const isNone = selected !== null && selected.length === 0;

  const toggle = v => {
    if (isAll) {
      // ALL mode → uncheck one = "all except this one"
      const next = items.map(i => i.v).filter(x => x !== v);
      onChange(next.length === 0 ? [] : next);
    } else {
      const next = selected.includes(v)
        ? selected.filter(x => x !== v)
        : [...selected, v];
      // Normalize: every item checked → ALL (null); none left → NONE ([])
      onChange(next.length === items.length ? null : next);
    }
  };

  const displayLabel = isAll  ? allLabel
    : isNone             ? 'None'
    : selected.length === 1 ? selected[0]
    :                        `${selected.length} selected`;

  // Trigger button is accented when NOT in ALL mode (i.e. something is filtered)
  const isFiltered = !isAll;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3, position:'relative' }}>
      <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>{label}</span>

      <button onClick={() => setOpen(o => !o)} className="mono"
        style={{
          display:'flex', alignItems:'center', gap:5,
          background:'var(--surface)',
          color: isNone ? 'var(--col-cancel)' : isFiltered ? ac : 'var(--ink-2)',
          border:`1px solid ${isNone ? 'color-mix(in oklch,var(--col-cancel) 55%,transparent)' : isFiltered ? `color-mix(in oklch,${ac} 55%,transparent)` : 'var(--line)'}`,
          borderRadius:4, padding:'4px 8px', fontSize:11, outline:'none',
          cursor:'pointer', textAlign:'left', minWidth:148, height:28,
        }}>
        <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {displayLabel}
        </span>
        {!isAll && !isNone && selected.length > 0 && (
          <span style={{ background:`color-mix(in oklch,${ac} 20%,transparent)`, color: ac, borderRadius:999, fontSize:8, padding:'0 5px', lineHeight:'16px', flexShrink:0 }}>
            {selected.length}
          </span>
        )}
        <span style={{ fontSize:7, color:'var(--ink-3)', flexShrink:0 }}>▾</span>
      </button>

      {open && (
        <>
          <div style={{ position:'fixed', inset:0, zIndex:49 }} onClick={() => setOpen(false)} />
          <div style={{
            position:'absolute', top:'calc(100% + 3px)', left:0, zIndex:50,
            background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius:6,
            boxShadow:'0 8px 28px oklch(0 0 0 / 0.45)',
            minWidth:192, maxHeight:300, display:'flex', flexDirection:'column', overflow:'hidden',
          }}>
            <div style={{ padding:'5px 8px', borderBottom:'1px solid var(--line-soft)', display:'flex', alignItems:'center', gap:6 }}>
              {/* ALL — null → every item passes */}
              <button onClick={() => { onChange(null); setOpen(false); }} className="mono uc"
                style={{
                  flex:1, padding:'3px 0', fontSize:8, borderRadius:3,
                  border:`1px solid ${isAll ? ac : 'var(--line)'}`,
                  background: isAll ? `color-mix(in oklch,${ac} 12%,transparent)` : 'transparent',
                  color: isAll ? ac : 'var(--ink-3)',
                  fontWeight: isAll ? 600 : 400, cursor:'pointer',
                }}>ALL</button>
              {/* NONE — [] → nothing passes; user builds selection from scratch */}
              <button onClick={() => { onChange([]); setOpen(false); }} className="mono uc"
                style={{
                  flex:1, padding:'3px 0', fontSize:8, borderRadius:3,
                  border:`1px solid ${isNone ? 'var(--col-cancel)' : 'var(--line)'}`,
                  background: isNone ? 'color-mix(in oklch,var(--col-cancel) 12%,transparent)' : 'transparent',
                  color: isNone ? 'var(--col-cancel)' : 'var(--ink-3)',
                  fontWeight: isNone ? 600 : 400, cursor:'pointer',
                }}>NONE</button>
            </div>
            <div style={{ overflowY:'auto', flex:1 }}>
              {items.map(item => {
                const checked = isAll || (!isNone && selected.includes(item.v));
                return (
                  <label key={item.v} onClick={() => toggle(item.v)}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 10px', cursor:'pointer', background: checked ? `color-mix(in oklch,${ac} 10%,transparent)` : 'transparent' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(item.v)}
                      onClick={e => e.stopPropagation()}
                      style={{ accentColor: ac, flexShrink:0, cursor:'pointer' }} />
                    <span className="mono" style={{ fontSize:10, color: item.badge ? 'var(--ink-3)' : 'var(--ink)', userSelect:'none', flex:1 }}>{item.l}</span>
                    {item.badge && (
                      <span className="mono uc" style={{ fontSize:7, padding:'1px 5px', borderRadius:3, fontWeight:600,
                        background: item.badge==='GND' ? 'color-mix(in oklch,var(--col-cancel) 16%,transparent)' : 'color-mix(in oklch,#3b82f6 16%,transparent)',
                        color: item.badge==='GND' ? 'var(--col-cancel)' : '#3b82f6',
                        boxShadow: item.badge==='GND' ? 'inset 0 0 0 1px color-mix(in oklch,var(--col-cancel) 40%,transparent)' : 'inset 0 0 0 1px color-mix(in oklch,#3b82f6 40%,transparent)',
                      }}>{item.badge}</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main timeline ────────────────────────────────────────────────────────
function AsfTimeline({ baseMap, allFIs, allTails, windowFrom, windowTo, rwyStart, rwyEnd, allResults, activatedSlots, hoveredSlot, onSlotHover, onAvailableSlotClick, onReservedSlotClick, hourEnd, leavesMap, maintTailSet }) {
  const [timelineTab,  setTimelineTab]  = useS_asf('fi');
  const [showDetails,  setShowDetails]  = useS_asf(false); // OFF by default for performance
  const _app = useApp();
  const LABEL_W   = 140;
  const HOUR_END  = Math.max(ASF_HOUR_END, hourEnd || ASF_HOUR_END);
  const BASE_MIN  = ASF_HOUR_START * 60;
  const SPAN_MIN  = (HOUR_END - ASF_HOUR_START) * 60;
  const pct  = m  => `${Math.max(0, Math.min(100, ((m - BASE_MIN) / SPAN_MIN) * 100))}%`;
  const wpct = dm => `${Math.max(0, (dm / SPAN_MIN) * 100)}%`;
  const wStart = minutesOf(windowFrom) ?? BASE_MIN;
  const wEnd   = minutesOf(windowTo)   ?? (BASE_MIN + SPAN_MIN);
  const { rawFI, rawTail } = baseMap;
  const allSlots = Object.values(allResults).flat();
  const avFISet   = new Set(allSlots.flatMap(s => s.pairs.map(p => p.fi)));
  const avTailSet = new Set(allSlots.flatMap(s => s.pairs.map(p => p.tail)));
  const actList   = Object.values(activatedSlots);

  const isHovSlot = slot => hoveredSlot && hoveredSlot.t === slot.t && hoveredSlot.end === slot.end;

  const sections = [
    { id:'fi', label:'FLIGHT INSTRUCTORS', rows:[...allFIs].sort(),   raw:rawFI,   avSet:avFISet,
      getAct: k => actList.filter(a => a.fi   === k),
      inPairs: (slot, k) => slot.pairs.some(p => p.fi   === k) },
    { id:'ac', label:'AIRCRAFT',           rows:[...allTails].sort(), raw:rawTail, avSet:avTailSet,
      getAct: k => actList.filter(a => a.tail === k),
      inPairs: (slot, k) => slot.pairs.some(p => p.tail === k) },
  ];
  const section = sections.find(s => s.id === timelineTab) || sections[0];

  return (
    <div style={{ boxShadow:'inset 0 0 0 1px var(--line)', borderRadius:6, overflow:'hidden', background:'var(--surface)', flexShrink:0 }}>

      {/* Combined header: label+tabs | hour ruler (same 2-col grid as rows so they align) */}
      <div style={{ display:'grid', gridTemplateColumns:`${LABEL_W}px 1fr`, background:'var(--bg-2)', borderBottom:'1px solid var(--line)', height:28, flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:4, padding:'0 6px', borderRight:'1px solid var(--line)', overflow:'hidden' }}>
          <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', whiteSpace:'nowrap', flexShrink:0, marginRight:2 }}>
            {actList.length ? `${actList.length} RSRV` : 'TL'}
          </span>
          {sections.map(s => (
            <button key={s.id} onClick={() => setTimelineTab(s.id)} className="mono uc"
              style={{ height:16, padding:'0 6px', fontSize:8, borderRadius:3, cursor:'pointer', flexShrink:0,
                border:`1px solid ${timelineTab===s.id?'var(--col-pending)':'var(--line)'}`,
                background: timelineTab===s.id ? 'color-mix(in oklch,var(--col-pending) 16%,transparent)' : 'transparent',
                color: timelineTab===s.id ? 'var(--col-pending)' : 'var(--ink-3)',
                fontWeight: timelineTab===s.id ? 600 : 400,
              }}>{s.id === 'fi' ? 'FI' : 'A/C'}</button>
          ))}
          {/* Details toggle — default OFF for performance */}
          <button onClick={() => setShowDetails(v => !v)} className="mono uc"
            title={showDetails ? 'Hide flight details in occupied blocks (faster)' : 'Show flight details in occupied blocks (click to open Drawer)'}
            style={{ height:16, padding:'0 5px', fontSize:7, borderRadius:3, cursor:'pointer', flexShrink:0, marginLeft:2,
              border:`1px solid ${showDetails?'var(--col-done)':'var(--line)'}`,
              background: showDetails ? 'color-mix(in oklch,var(--col-done) 14%,transparent)' : 'transparent',
              color: showDetails ? 'var(--col-done)' : 'var(--ink-3)',
              fontWeight: showDetails ? 600 : 400,
            }}>DETAILS</button>
        </div>
        <div style={{ position:'relative' }}>
          <div style={{ position:'absolute', left:pct(Math.max(BASE_MIN,wStart)), width:wpct(Math.min(BASE_MIN+SPAN_MIN,wEnd)-Math.max(BASE_MIN,wStart)), top:0, bottom:0, background:'color-mix(in oklch,var(--col-pending) 8%,transparent)', pointerEvents:'none' }}/>
          {rwyStart != null && rwyEnd != null && (
            <div style={{ position:'absolute', left:pct(Math.max(BASE_MIN,rwyStart)), width:wpct(Math.min(BASE_MIN+SPAN_MIN,rwyEnd)-Math.max(BASE_MIN,rwyStart)), top:0, bottom:0, background:'color-mix(in oklch,var(--col-cancel) 18%,transparent)', pointerEvents:'none' }}/>
          )}
          {Array.from({ length: HOUR_END - ASF_HOUR_START + 1 }, (_,i) => (
            <div key={i} className="mono num" style={{ position:'absolute', left:pct((ASF_HOUR_START+i)*60), top:0, bottom:0, borderLeft:i===0?'none':'1px solid var(--line-soft)', paddingLeft:3, fontSize:9, color:'var(--ink-3)', display:'flex', alignItems:'center' }}>{ASF_HOUR_START+i}</div>
          ))}
        </div>
      </div>

      <div style={{ maxHeight:268, overflowY:'auto' }}>
        {section.rows.map((rowKey, ri) => {
          const flights     = section.raw[rowKey] || [];
          const hasSlots    = section.avSet.has(rowKey);
          const activated   = section.getAct(rowKey);
          const hasAct      = activated.length > 0;
          // Per-row status
          const fiOnLeave   = section.id === 'fi' && !!leavesMap && Object.keys(leavesMap).some(k => asfShortName(k).toLowerCase() === asfShortName(rowKey).toLowerCase());
          const acOnMaint   = section.id === 'ac' && !!maintTailSet && maintTailSet.has(rowKey);
          const rowDisabled = fiOnLeave || acOnMaint;
          return (
            <div key={rowKey} style={{ display:'grid', gridTemplateColumns:`${LABEL_W}px 1fr`, borderBottom:'1px solid var(--line-soft)', minHeight:30,
              background: hasAct ? 'color-mix(in oklch,var(--highlight) 4%,transparent)' : rowDisabled ? 'color-mix(in oklch,var(--ink) 3%,transparent)' : ri%2 ? 'transparent' : 'color-mix(in oklch,var(--ink) 1.5%,transparent)', transition:'background .15s',
              opacity: rowDisabled ? 0.5 : 1 }}>
              <div style={{ padding:'0 8px', display:'flex', alignItems:'center', gap:5, borderRight:'1px solid var(--line)', overflow:'hidden' }}>
                <span style={{ fontSize:9, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1,
                  color: hasAct ? 'var(--highlight)' : rowDisabled ? 'var(--ink-3)' : hasSlots ? 'var(--ink)' : 'var(--ink-3)',
                  fontWeight: hasAct || hasSlots ? 600 : 400 }}>{rowKey}</span>
                {fiOnLeave && <span className="mono uc" style={{ fontSize:6, padding:'1px 4px', borderRadius:2, fontWeight:700, flexShrink:0, background:'color-mix(in oklch,#3b82f6 16%,transparent)', color:'#3b82f6', boxShadow:'inset 0 0 0 1px color-mix(in oklch,#3b82f6 40%,transparent)' }}>LEAVE</span>}
                {acOnMaint  && <span className="mono uc" style={{ fontSize:6, padding:'1px 4px', borderRadius:2, fontWeight:700, flexShrink:0, background:'color-mix(in oklch,var(--col-cancel) 16%,transparent)', color:'var(--col-cancel)', boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-cancel) 40%,transparent)' }}>GND</span>}
              </div>
              <div style={{ position:'relative' }}>
                {Array.from({ length: HOUR_END - ASF_HOUR_START }, (_,i) => (
                  <div key={i} style={{ position:'absolute', left:pct((ASF_HOUR_START+i)*60), top:0, bottom:0, borderLeft:'1px solid var(--line-soft)', opacity:0.35, pointerEvents:'none' }}/>
                ))}
                <div style={{ position:'absolute', left:pct(Math.max(BASE_MIN,wStart)), width:wpct(Math.min(BASE_MIN+SPAN_MIN,wEnd)-Math.max(BASE_MIN,wStart)), top:0, bottom:0, background:'color-mix(in oklch,var(--col-pending) 5%,transparent)', pointerEvents:'none' }}/>
                {rwyStart != null && rwyEnd != null && (
                  <div style={{ position:'absolute', left:pct(Math.max(BASE_MIN,rwyStart)), width:wpct(Math.min(BASE_MIN+SPAN_MIN,rwyEnd)-Math.max(BASE_MIN,rwyStart)), top:0, bottom:0, background:'color-mix(in oklch,var(--col-cancel) 8%,transparent)', pointerEvents:'none' }}/>
                )}
                {flights.map((fl, fi) => {
                  if (!showDetails) {
                    return (
                      <div key={fi} style={{
                        position:'absolute',
                        left:pct(Math.max(BASE_MIN,fl.s)),
                        width:wpct(Math.min(BASE_MIN+SPAN_MIN,fl.e)-Math.max(BASE_MIN,fl.s)),
                        top:4, bottom:4,
                        background:'color-mix(in oklch,var(--ink-2) 25%,transparent)',
                        boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--ink-2) 40%,transparent)',
                        borderRadius:3, pointerEvents:'none',
                      }}/>
                    );
                  }
                  const flObj = fl.flight;
                  const flColor = flObj ? STATUS_COLOR(flObj) : 'var(--ink-2)';
                  return (
                    <button key={fi}
                      onClick={() => flObj && _app.setDrawer(flObj.id)}
                      title={flObj ? `${flObj.start}–${flObj.end} · ${flObj.student||flObj.instructor||''} · ${flObj.lesson||''}` : ''}
                      style={{
                        position:'absolute', left:pct(Math.max(BASE_MIN,fl.s)),
                        width:`calc(${wpct(Math.min(BASE_MIN+SPAN_MIN,fl.e)-Math.max(BASE_MIN,fl.s))} - 1px)`,
                        top:3, bottom:3,
                        background:`color-mix(in oklch,${flColor} 22%,transparent)`,
                        boxShadow:`inset 0 0 0 1px color-mix(in oklch,${flColor} 40%,transparent)`,
                        borderLeft: flObj ? `3px solid ${flColor}` : 'none',
                        borderRadius:3, cursor: flObj ? 'pointer' : 'default',
                        overflow:'hidden', textAlign:'left', padding:'1px 3px',
                      }}>
                      {flObj && (
                        <div className="mono" style={{ fontSize:7, lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--ink)' }}>
                          <span style={{ fontWeight:600 }}>{flObj.start}</span>{' '}{flObj.lesson || flObj.student || ''}
                        </div>
                      )}
                    </button>
                  );
                })}
                {/* Available slots — hover sync + click to reserve */}
                {allSlots.map((slot, si) => {
                  if (!section.inPairs(slot, rowKey)) return null;
                  const hov = isHovSlot(slot);
                  return (
                    <div key={`av-${si}`}
                      onMouseEnter={() => onSlotHover({ t: slot.t, end: slot.end })}
                      onMouseLeave={() => onSlotHover(null)}
                      onClick={() => onAvailableSlotClick && onAvailableSlotClick(slot)}
                      style={{
                        position:'absolute',
                        left:pct(Math.max(BASE_MIN,slot.t)), width:wpct(slot.end-slot.t),
                        top: hov ? 1 : 5, bottom: hov ? 1 : 5,
                        background: hov ? 'color-mix(in oklch,var(--col-done) 38%,transparent)' : 'color-mix(in oklch,var(--col-done) 18%,transparent)',
                        boxShadow: hov ? 'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 80%,transparent)' : 'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 45%,transparent)',
                        borderRadius:3, cursor:'pointer', transition:'all .1s', zIndex: hov ? 2 : 1,
                      }}/>
                  );
                })}
                {/* Activated (reserved) slots — click to release */}
                {activated.map((act, ai) => (
                  <div key={`act-${ai}`}
                    onClick={() => onReservedSlotClick && onReservedSlotClick(act)}
                    title={`${act.spName}: ${asfMinsToHHMM(act.t)}–${asfMinsToHHMM(act.end)} — click to release`}
                    style={{ position:'absolute', left:pct(Math.max(BASE_MIN,act.t)), width:wpct(act.end-act.t), top:3, bottom:3,
                      background:'color-mix(in oklch,var(--highlight) 28%,transparent)',
                      boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 65%,transparent)',
                      borderRadius:3, display:'flex', alignItems:'center', overflow:'hidden', paddingLeft:3,
                      zIndex:3, cursor:'pointer' }}>
                    <span className="mono" style={{ fontSize:7, color:'var(--highlight)', fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{act.spName}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display:'flex', gap:12, padding:'4px 10px', flexWrap:'wrap', borderTop:'1px solid var(--line-soft)', background:'color-mix(in oklch,var(--ink) 2%,var(--surface))' }}>
        {[
          ['color-mix(in oklch,var(--ink-2) 28%,transparent)',     'inset 0 0 0 1px color-mix(in oklch,var(--ink-2) 45%,transparent)',     'Scheduled'],
          ['color-mix(in oklch,var(--col-done) 18%,transparent)',  'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 45%,transparent)',  'Available (click to reserve)'],
          ['color-mix(in oklch,var(--highlight) 28%,transparent)', 'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 65%,transparent)', 'Reserved (click to release)'],
          ['color-mix(in oklch,var(--col-pending) 8%,transparent)','none', 'Search window'],
          ['color-mix(in oklch,var(--col-cancel) 18%,transparent)','none', 'RWY closed'],
        ].map(([bg, shadow, lbl]) => (
          <div key={lbl} style={{ display:'flex', alignItems:'center', gap:4 }}>
            <div style={{ width:12, height:8, borderRadius:2, background:bg, boxShadow:shadow }}/>
            <span className="mono" style={{ fontSize:8, color:'var(--ink-3)' }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Mini timeline (inside expanded SP card) ──────────────────────────────
function AsfMiniTimeline({ slots, activatedSlot, windowFrom, windowTo, rwyStart, rwyEnd, hoveredSlot, onSlotHover, hourEnd }) {
  const HOUR_END = Math.max(ASF_HOUR_END, hourEnd || ASF_HOUR_END);
  const BASE_MIN = ASF_HOUR_START * 60;
  const SPAN_MIN = (HOUR_END - ASF_HOUR_START) * 60;
  const pct  = m  => `${Math.max(0, Math.min(100, ((m - BASE_MIN) / SPAN_MIN) * 100))}%`;
  const wpct = dm => `${Math.max(0, (dm / SPAN_MIN) * 100)}%`;
  const wStart = minutesOf(windowFrom) ?? BASE_MIN;
  const wEnd   = minutesOf(windowTo)   ?? (BASE_MIN + SPAN_MIN);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
      <div style={{ display:'grid', gridTemplateColumns:'60px 1fr', height:14 }}>
        <div/>
        <div style={{ position:'relative' }}>
          {Array.from({ length: HOUR_END - ASF_HOUR_START + 1 }, (_,i) => (
            <div key={i} className="mono num" style={{ position:'absolute', left:pct((ASF_HOUR_START+i)*60), top:0, fontSize:7, color:'var(--ink-3)', paddingLeft:1 }}>{ASF_HOUR_START+i}</div>
          ))}
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'60px 1fr', height:20 }}>
        <div className="mono uc" style={{ fontSize:7, color:'var(--ink-3)', display:'flex', alignItems:'center', paddingLeft:2 }}>SLOTS</div>
        <div style={{ position:'relative', background:'color-mix(in oklch,var(--ink) 3%,transparent)', borderRadius:3 }}>
          <div style={{ position:'absolute', left:pct(Math.max(BASE_MIN,wStart)), width:wpct(Math.min(BASE_MIN+SPAN_MIN,wEnd)-Math.max(BASE_MIN,wStart)), top:0, bottom:0, background:'color-mix(in oklch,var(--col-pending) 9%,transparent)' }}/>
          {rwyStart != null && rwyEnd != null && (
            <div style={{ position:'absolute', left:pct(Math.max(BASE_MIN,rwyStart)), width:wpct(Math.min(BASE_MIN+SPAN_MIN,rwyEnd)-Math.max(BASE_MIN,rwyStart)), top:0, bottom:0, background:'color-mix(in oklch,var(--col-cancel) 14%,transparent)' }}/>
          )}
          {slots.map((slot, si) => {
            const isAct = activatedSlot && activatedSlot.t === slot.t && activatedSlot.end === slot.end;
            const hov   = hoveredSlot && hoveredSlot.t === slot.t && hoveredSlot.end === slot.end;
            return (
              <div key={si}
                onMouseEnter={() => onSlotHover({ t: slot.t, end: slot.end })}
                onMouseLeave={() => onSlotHover(null)}
                style={{
                  position:'absolute',
                  left:pct(Math.max(BASE_MIN,slot.t)), width:wpct(slot.end-slot.t),
                  top: hov ? 0 : 2, bottom: hov ? 0 : 2,
                  background: isAct
                    ? 'color-mix(in oklch,var(--highlight) 38%,transparent)'
                    : hov ? 'color-mix(in oklch,var(--col-done) 40%,transparent)' : 'color-mix(in oklch,var(--col-done) 28%,transparent)',
                  boxShadow: isAct
                    ? 'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 65%,transparent)'
                    : hov ? 'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 80%,transparent)' : 'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 55%,transparent)',
                  borderRadius:2, cursor:'pointer', transition:'all .1s',
                }}/>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── AsfAcPickerModal (pick FI+tail when RESERVE button clicked) ──────────
function AsfAcPickerModal({ slot, spName, onReserve, onClose }) {
  const byFI = {};
  slot.pairs.forEach(({ fi, tail }) => { (byFI[fi] = byFI[fi] || []).push(tail); });
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:300, background:'oklch(0 0 0 / 0.55)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-2)', boxShadow:'0 18px 48px oklch(0 0 0 / 0.55)', borderRadius:8, width:400, maxWidth:'100%', maxHeight:'80vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ width:7, height:7, borderRadius:999, background:'var(--col-done)', boxShadow:'0 0 6px var(--col-done)' }}/>
          <span className="mono uc" style={{ fontSize:11, fontWeight:700 }}>RESERVE SLOT</span>
          <span className="mono" style={{ fontSize:10, color:'var(--ink-3)' }}>for {spName}</span>
          <span style={{ flex:1 }}/>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--ink-3)', cursor:'pointer', fontSize:18, lineHeight:1, padding:'0 4px' }}>✕</button>
        </div>
        <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--line-soft)', display:'flex', alignItems:'center', gap:10 }}>
          <span className="mono num" style={{ fontSize:14, fontWeight:700, color:'var(--col-done)' }}>
            {asfMinsToHHMM(slot.t)} – {asfMinsToHHMM(slot.end)}
          </span>
          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>{asfFmtDur(slot.end-slot.t)} · {slot.pairs.length} combo{slot.pairs.length>1?'s':''}</span>
        </div>
        <div style={{ overflowY:'auto', flex:1, padding:'10px 14px', display:'flex', flexDirection:'column', gap:12 }}>
          {Object.entries(byFI).sort(([a],[b]) => a.localeCompare(b)).map(([fi, tails]) => (
            <div key={fi}>
              <div style={{ fontSize:10, color:'var(--ink-2)', fontWeight:600, marginBottom:6 }}>{fi}</div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {[...tails].sort().map(tail => {
                  const res = RESOURCES.find(r => r.tail === tail);
                  return (
                    <button key={tail} onClick={() => { onReserve(fi, tail); onClose(); }}
                      className="mono" style={{ padding:'6px 14px', fontSize:10, borderRadius:4, cursor:'pointer', fontWeight:600,
                        boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 55%,transparent)',
                        background:'color-mix(in oklch,var(--col-done) 12%,transparent)',
                        color:'var(--col-done)', transition:'all .1s',
                      }}>
                      {tail}{res?.acType ? ` · ${res.acType}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── AsfTimelineSlotModal (click available slot in main timeline) ─────────
function AsfTimelineSlotModal({ slot, slotsByStudent, ranked, activatedSlots, onReserve, onClose }) {
  const matching = [];
  ranked.forEach(rec => {
    const spKey = asfShortName(rec.student.name);
    const spSlots = slotsByStudent[spKey] || [];
    const match = spSlots.find(s => s.t === slot.t && s.end === slot.end);
    if (!match) return;
    matching.push({ rec, spKey, pairs: match.pairs, reserved: activatedSlots[spKey] || null });
  });

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:300, background:'oklch(0 0 0 / 0.55)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-2)', boxShadow:'0 18px 48px oklch(0 0 0 / 0.55)', borderRadius:8, width:480, maxWidth:'100%', maxHeight:'85vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ width:7, height:7, borderRadius:999, background:'var(--col-done)', boxShadow:'0 0 6px var(--col-done)' }}/>
          <span className="mono num" style={{ fontSize:13, fontWeight:700, color:'var(--col-done)' }}>
            {asfMinsToHHMM(slot.t)} – {asfMinsToHHMM(slot.end)}
          </span>
          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>{asfFmtDur(slot.end-slot.t)} · {slot.pairs.length} combo{slot.pairs.length>1?'s':''}</span>
          <span style={{ flex:1 }}/>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--ink-3)', cursor:'pointer', fontSize:18, lineHeight:1 }}>✕</button>
        </div>
        {matching.length === 0 ? (
          <div className="mono uc" style={{ padding:'24px', textAlign:'center', color:'var(--ink-3)', fontSize:10 }}>No ranked SPs have this slot available.</div>
        ) : (
          <div style={{ overflowY:'auto', flex:1, padding:'8px 14px', display:'flex', flexDirection:'column', gap:10 }}>
            {matching.map(({ rec, spKey, pairs, reserved }) => {
              const byFI = {};
              pairs.forEach(({ fi, tail }) => { (byFI[fi] = byFI[fi] || []).push(tail); });
              return (
                <div key={spKey} style={{ borderRadius:5, padding:'8px 10px', background: reserved ? 'color-mix(in oklch,var(--highlight) 6%,transparent)' : 'color-mix(in oklch,var(--ink) 3%,transparent)', boxShadow:`inset 0 0 0 1px ${reserved ? 'color-mix(in oklch,var(--highlight) 30%,transparent)' : 'var(--line)'}` }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom: reserved ? 4 : 8 }}>
                    <span className="mono" style={{ width:20, height:20, borderRadius:4, background: reserved ? 'var(--highlight)' : 'var(--ink-3)', color:'oklch(0.12 0 0)', fontWeight:700, fontSize:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{rec.rank}</span>
                    <span style={{ fontSize:11, fontWeight:600, color: reserved ? 'var(--highlight)' : 'var(--ink)' }}>{asfShortName(rec.student.name)}</span>
                    {rec.student.nick && <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>{rec.student.nick}</span>}
                    {reserved && (
                      <span className="mono uc" style={{ fontSize:8, padding:'1px 6px', borderRadius:3, background:'color-mix(in oklch,var(--highlight) 14%,transparent)', boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 45%,transparent)', color:'var(--highlight)', fontWeight:600 }}>RESERVED</span>
                    )}
                  </div>
                  {!reserved && (
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {Object.entries(byFI).sort(([a],[b]) => a.localeCompare(b)).map(([fi, tails]) => (
                        <div key={fi} style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                          <span style={{ fontSize:9, color:'var(--ink-2)', minWidth:120 }}>{fi}</span>
                          {[...tails].sort().map(tail => {
                            const res = RESOURCES.find(r => r.tail === tail);
                            return (
                              <button key={tail} onClick={() => { onReserve(spKey, asfShortName(rec.student.name), slot.t, slot.end, fi, tail); onClose(); }}
                                className="mono" style={{ padding:'3px 10px', fontSize:9, borderRadius:3, cursor:'pointer', fontWeight:600,
                                  boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 55%,transparent)',
                                  background:'color-mix(in oklch,var(--col-done) 12%,transparent)', color:'var(--col-done)',
                                }}>
                                {tail}{res?.acType ? ` · ${res.acType}` : ''}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AsfTimelineReleaseModal (click reserved slot in main timeline) ───────
function AsfTimelineReleaseModal({ act, onRelease, onClose }) {
  const res = RESOURCES.find(r => r.tail === act.tail);
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:300, background:'oklch(0 0 0 / 0.55)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-2)', boxShadow:'0 18px 48px oklch(0 0 0 / 0.55)', borderRadius:8, width:340, maxWidth:'100%', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ width:7, height:7, borderRadius:999, background:'var(--highlight)', boxShadow:'0 0 6px var(--highlight)' }}/>
          <span className="mono uc" style={{ fontSize:11, fontWeight:700 }}>RESERVED SLOT</span>
          <span style={{ flex:1 }}/>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--ink-3)', cursor:'pointer', fontSize:18, lineHeight:1 }}>✕</button>
        </div>
        <div style={{ padding:'14px', display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ display:'flex', flexDirection:'column', gap:5, padding:'10px', borderRadius:5, background:'color-mix(in oklch,var(--highlight) 6%,transparent)', boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 30%,transparent)' }}>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', minWidth:40 }}>SP</span>
              <span style={{ fontSize:12, fontWeight:600, color:'var(--highlight)' }}>{act.spName}</span>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', minWidth:40 }}>TIME</span>
              <span className="mono num" style={{ fontSize:12, fontWeight:600, color:'var(--ink)' }}>{asfMinsToHHMM(act.t)} – {asfMinsToHHMM(act.end)}</span>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', minWidth:40 }}>FI</span>
              <span style={{ fontSize:11, color:'var(--ink-2)' }}>{act.fi}</span>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', minWidth:40 }}>A/C</span>
              <span className="mono" style={{ fontSize:11, color:'var(--ink-2)' }}>{act.tail}{res?.acType ? ` · ${res.acType}` : ''}</span>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:4 }}>
            <button onClick={onClose} className="mono uc"
              style={{ padding:'6px 14px', fontSize:9, borderRadius:4, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)' }}>KEEP</button>
            <button onClick={() => { onRelease(act.spKey); onClose(); }} className="mono uc"
              style={{ padding:'6px 14px', fontSize:9, borderRadius:4, cursor:'pointer', fontWeight:600,
                border:'1px solid color-mix(in oklch,var(--col-cancel) 55%,transparent)',
                background:'color-mix(in oklch,var(--col-cancel) 14%,transparent)',
                color:'var(--col-cancel)' }}>RELEASE SLOT ▼</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slot button ──────────────────────────────────────────────────────────
// onOpenPicker() — called when user clicks RESERVE; caller (AsfStudentCard)
// lifts the modal to board level so the backdrop is never nested inside this div.
function AsfSlotBtn({ slot, isActive, onRelease, onReservePair, activePair, isHovered, onHoverChange, spName, onOpenPicker }) {
  const byFI = {};
  slot.pairs.forEach(({ fi, tail }) => { (byFI[fi] = byFI[fi] || []).push(tail); });
  const fiEntries = Object.entries(byFI).sort(([a],[b]) => a.localeCompare(b));
  const nCombos = slot.pairs.length;
  const nFIs    = fiEntries.length;
  const nTails  = new Set(slot.pairs.map(p => p.tail)).size;

  const accent = isActive ? 'var(--highlight)'
    : nCombos >= 6 ? 'var(--col-done)'
    : nCombos >= 3 ? 'var(--col-pending)'
    :                'var(--col-cancel)';

  const hoverGlow = isHovered && !isActive
    ? 'inset 0 0 0 2px color-mix(in oklch,var(--col-done) 70%,transparent)' : null;

  return (
    <div
      onMouseEnter={() => onHoverChange({ t: slot.t, end: slot.end })}
      onMouseLeave={() => onHoverChange(null)}
      style={{
        background: isActive
          ? `linear-gradient(to right, var(--highlight) 3px, color-mix(in oklch,var(--highlight) 8%,var(--surface)) 3px)`
          : `linear-gradient(to right, ${accent} 3px, var(--surface) 3px)`,
        boxShadow: hoverGlow || `inset 0 0 0 1px color-mix(in oklch,${accent} ${isActive?55:22}%,var(--line))`,
        borderRadius:5, padding:'7px 10px',
        display:'flex', flexDirection:'column', gap:6,
        transition:'all .1s',
        transform: isHovered && !isActive ? 'translateX(2px)' : 'none',
      }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <span className="mono num" style={{ fontSize:13, fontWeight:700, color: isActive ? 'var(--highlight)' : isHovered ? 'var(--col-done)' : 'var(--ink)' }}>
          {asfMinsToHHMM(slot.t)} – {asfMinsToHHMM(slot.end)}
        </span>
        <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>
          {asfFmtDur(slot.end - slot.t)} · {nFIs} FI{nFIs>1?'s':''} · {nTails} A/C
        </span>
        <span style={{ flex:1 }}/>
        <span className="mono" style={{ fontSize:10, fontWeight:700, color:accent }}>{nCombos}&thinsp;COMBO{nCombos>1?'S':''}</span>
        {isActive ? (
          <button onClick={e => { e.stopPropagation(); onRelease(); }} className="mono uc"
            style={{ padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
              background:'color-mix(in oklch,var(--col-cancel) 12%,transparent)',
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-cancel) 55%,transparent)',
              color:'var(--col-cancel)', fontWeight:600 }}>RELEASE ▼</button>
        ) : (
          <button onClick={e => { e.stopPropagation(); onOpenPicker(); }} className="mono uc"
            style={{ padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
              background:'color-mix(in oklch,var(--col-done) 12%,transparent)',
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 55%,transparent)',
              color:'var(--col-done)', fontWeight:600 }}>RESERVE ▲</button>
        )}
      </div>

      {isActive && activePair && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span className="mono uc" style={{ fontSize:7, color:'var(--ink-3)' }}>RESERVED AS</span>
          <span className="mono" style={{ fontSize:10, color:'var(--highlight)', fontWeight:600 }}>{activePair.fi}</span>
          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>+</span>
          <span className="mono" style={{ fontSize:10, color:'var(--highlight)', fontWeight:600 }}>{activePair.tail}</span>
        </div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
        {fiEntries.map(([fi, tails]) => (
          <div key={fi} style={{ display:'flex', alignItems:'flex-start', gap:8, flexWrap:'wrap' }}>
            <span style={{ fontSize:10, minWidth:130, flexShrink:0, paddingTop:3,
              fontWeight: isActive && activePair?.fi===fi ? 700 : 400,
              color: isActive && activePair?.fi===fi ? 'var(--highlight)' : 'var(--ink-2)' }}>{fi}</span>
            <div style={{ display:'flex', gap:4, flexWrap:'wrap', flex:1 }}>
              {[...tails].sort().map(tail => {
                const res = RESOURCES.find(r => r.tail === tail);
                const isActiveTail = isActive && activePair?.tail === tail && activePair?.fi === fi;
                return (
                  <button key={tail} onClick={e => { e.stopPropagation(); if (!isActive) onReservePair(fi, tail); }}
                    className="mono"
                    disabled={isActive && !isActiveTail}
                    style={{ fontSize:9, padding:'2px 8px', borderRadius:4, cursor: isActive ? 'default' : 'pointer',
                      background: isActiveTail ? 'color-mix(in oklch,var(--highlight) 18%,transparent)' : 'color-mix(in oklch,var(--col-done) 10%,transparent)',
                      boxShadow: isActiveTail ? 'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 55%,transparent)' : 'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 28%,transparent)',
                      color: isActiveTail ? 'var(--highlight)' : 'var(--col-done)',
                      fontWeight: isActiveTail ? 700 : 400,
                      transition:'all .1s',
                      border:'none',
                    }}>
                    {tail}{res?.acType ? ` · ${res.acType}` : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

// ─── Propose modal ────────────────────────────────────────────────────────
function AsfProposeModal({ student, activatedSlot, dateStr, onClose }) {
  const [copied, setCopied] = useS_asf(false);
  const { wd, day, mo, y } = fmtDay(dateStr);
  const dur = activatedSlot.end - activatedSlot.t;
  const res = RESOURCES.find(r => r.tail === activatedSlot.tail);

  const proposalText = [
    `AP-127 SLOT PROPOSAL`,
    `Date  : ${wd} ${String(day).padStart(2,'0')} ${mo} ${y}`,
    `Time  : ${asfMinsToHHMM(activatedSlot.t)} – ${asfMinsToHHMM(activatedSlot.end)} (${asfFmtDur(dur)})`,
    `SP    : ${asfShortName(student.name)}${student.nick ? ` (${student.nick})` : ''}`,
    `Lesson: ${student.next_lesson || '—'}`,
    ``,
    `FI    : ${activatedSlot.fi}`,
    `A/C   : ${activatedSlot.tail}${res?.acType ? ` (${res.acType})` : ''}`,
  ].join('\n');

  const copyText = async () => {
    try { await navigator.clipboard.writeText(proposalText); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch (_) { const ta = document.getElementById('asf-proposal-textarea'); if (ta) { ta.focus(); ta.select(); } }
  };

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:300, background:'oklch(0 0 0 / 0.55)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'var(--bg-2)', boxShadow:'0 18px 48px oklch(0 0 0 / 0.55)', borderRadius:8, maxWidth:480, width:'100%', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ width:7, height:7, borderRadius:999, background:'var(--highlight)', boxShadow:'0 0 7px var(--highlight)' }}/>
          <span className="mono uc" style={{ fontSize:11, fontWeight:700, letterSpacing:'0.05em' }}>DISPATCHER PROPOSAL</span>
          <span style={{ flex:1 }}/>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--ink-3)', cursor:'pointer', fontSize:18, padding:'0 4px', lineHeight:1 }}>✕</button>
        </div>
        <div style={{ padding:'12px 14px', overflowY:'auto', flex:1 }}>
          <textarea id="asf-proposal-textarea" readOnly value={proposalText} className="mono"
            style={{ width:'100%', minHeight:180, background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)', borderRadius:5, padding:'10px 12px', fontSize:11, outline:'none', lineHeight:1.65, resize:'vertical', whiteSpace:'pre', boxSizing:'border-box' }}/>
        </div>
        <div style={{ padding:'10px 14px', borderTop:'1px solid var(--line)', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>✱ Confirm with dispatcher before locking in.</span>
          <span style={{ flex:1 }}/>
          <button onClick={onClose} className="mono uc" style={{ padding:'5px 12px', fontSize:9, borderRadius:4, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)' }}>CLOSE</button>
          <button onClick={copyText} className="mono uc" style={{ padding:'5px 14px', fontSize:9, borderRadius:4, cursor:'pointer', border:`1px solid ${copied?'var(--col-done)':'var(--highlight)'}`, background: copied ? 'color-mix(in oklch,var(--col-done) 16%,transparent)' : 'color-mix(in oklch,var(--highlight) 16%,transparent)', color: copied ? 'var(--col-done)' : 'var(--highlight)', fontWeight:600 }}>{copied ? 'COPIED ✓' : 'COPY TO CLIPBOARD'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Student card ─────────────────────────────────────────────────────────
function AsfStudentCard({
  rec, expanded, onToggle, onPropose,
  overrides, onOverrideChange,
  activatedSlot, onActivate, onRelease,
  fiOpts, seTypeOpts,
  windowFrom, windowTo, rwyStart, rwyEnd,
  hoveredSlot, onSlotHover,
  hourEnd,
  onOpenPicker,
}) {
  const { student, rank, rankCls, idle, slots, baselineCount, onLeave, hasFlight } = rec;
  // Cascade feedback: this SP would have `baselineCount` slots if no one had
  // reserved yet. If current `slots.length` is lower, other reservations are
  // blocking options. Don't flag SPs that already have their own reservation —
  // for them the slot count drop reflects their own activated flight, not a
  // cascade from someone else's choice. `baselineCount` is undefined before
  // any reservation is made (short-circuit path in baselineSlotsByStudent),
  // so guard with ??.
  const hasReservationLocal = !!activatedSlot;
  const blocked = !hasReservationLocal ? Math.max(0, (baselineCount ?? slots.length) - slots.length) : 0;
  const blockedAll = !hasReservationLocal && slots.length === 0 && (baselineCount ?? 0) > 0;
  const accent = rankCls === 'bad' ? 'var(--col-cancel)' : rankCls === 'mid' ? 'var(--col-pending)' : 'var(--col-done)';
  const idleColor = idle == null ? 'var(--ink-3)' : idle >= 6 ? 'var(--col-cancel)' : idle >= 3 ? 'var(--col-pending)' : 'var(--ink-2)';
  const slotBadge = slots.length === 0 ? 'NO SLOTS' : `${slots.length} SLOT${slots.length>1?'S':''}`;
  const hasReservation = !!activatedSlot;

  return (
    <div style={{ background: `linear-gradient(to right, ${hasReservation ? 'var(--highlight)' : accent} 4px, var(--surface) 4px)`, boxShadow: `inset 0 0 0 1px ${expanded ? `color-mix(in oklch,${accent} 50%,var(--line))` : 'var(--line)'}`, borderRadius:6, overflow:'hidden' }}>

      {/* Summary row — single line on wide layouts, wraps on narrow */}
      <div onClick={onToggle} style={{ background:'transparent', cursor:'pointer', width:'100%', textAlign:'left', padding:'6px 10px', display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' }}>
        <span className="mono" style={{ width:22, height:22, borderRadius:4, background: hasReservation ? 'var(--highlight)' : accent, color:'oklch(0.12 0 0)', fontWeight:700, fontSize:11, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{rank}</span>
        <span style={{ fontSize:12, fontWeight:600, color: hasReservation ? 'var(--highlight)' : 'var(--ink)', whiteSpace:'nowrap' }}>{asfShortName(student.name)}</span>
        {student.nick && <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', letterSpacing:'0.04em', whiteSpace:'nowrap' }}>{student.nick}</span>}
        <span style={{ color:'var(--line)', fontSize:10, flexShrink:0 }}>│</span>
        <span className="mono" style={{ fontSize:9, color:'var(--ink-2)', whiteSpace:'nowrap' }}>
          <span style={{ fontSize:7, color:'var(--ink-3)' }}>NEXT </span>{student.next_lesson || '—'}
        </span>
        <span className="mono num" style={{ fontSize:9, color:idleColor, fontWeight: idle != null && idle >= 6 ? 600 : 400, whiteSpace:'nowrap' }}>
          <span style={{ fontSize:7, color:'var(--ink-3)' }}>IDLE </span>{idle == null ? '—' : `${idle}d`}
        </span>
        <span style={{ flex:1 }}/>
        {hasReservation && (
          <>
            <span className="mono uc" style={{ padding:'3px 7px', borderRadius:4, fontSize:8, fontWeight:700, boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 55%,transparent)', background:'color-mix(in oklch,var(--highlight) 14%,transparent)', color:'var(--highlight)' }}>
              ★ {asfMinsToHHMM(activatedSlot.t)}–{asfMinsToHHMM(activatedSlot.end)}
            </span>
            <button onClick={e => { e.stopPropagation(); onRelease(); }} className="mono uc"
              style={{ padding:'3px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
                boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-cancel) 55%,transparent)',
                background:'color-mix(in oklch,var(--col-cancel) 12%,transparent)',
                color:'var(--col-cancel)', fontWeight:600 }}>
              RELEASE
            </button>
            <button onClick={e => { e.stopPropagation(); onPropose(); }} className="mono uc"
              style={{ padding:'3px 8px', fontSize:8, borderRadius:3, cursor:'pointer', boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--highlight) 55%,transparent)', background:'color-mix(in oklch,var(--highlight) 14%,transparent)', color:'var(--highlight)', fontWeight:600 }}>
              PROPOSE ▸
            </button>
          </>
        )}
        {onLeave && (
          <span className="mono uc" title={onLeave}
            style={{ padding:'3px 7px', borderRadius:4, fontSize:8, fontWeight:700,
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,#3b82f6 55%,transparent)',
              background:'color-mix(in oklch,#3b82f6 14%,transparent)',
              color:'#3b82f6' }}>ON LEAVE</span>
        )}
        {!onLeave && hasFlight && (
          <span className="mono uc" title="Already has a flight scheduled today"
            style={{ padding:'3px 7px', borderRadius:4, fontSize:8, fontWeight:700,
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-done) 55%,transparent)',
              background:'color-mix(in oklch,var(--col-done) 14%,transparent)',
              color:'var(--col-done)' }}>SCHEDULED</span>
        )}
        <span className="mono uc" style={{ padding:'3px 9px', borderRadius:4, fontSize:9, fontWeight:600, boxShadow: `inset 0 0 0 1px ${slots.length===0?'var(--line)':'color-mix(in oklch,var(--col-done) 45%,transparent)'}`, background: slots.length===0?'transparent':'color-mix(in oklch,var(--col-done) 12%,transparent)', color: slots.length===0?'var(--ink-3)':'var(--col-done)' }}>{slotBadge}</span>
        {/* Cascade feedback: amber chip when reservations reduced this SP's slot count,
            red chip when reservations have eliminated all options. Suppressed during
            the empty-reservation baseline short-circuit (blocked computes to 0). */}
        {blockedAll && (
          <span className="mono uc"
            title={`Baseline (no reservations): ${baselineCount} slots — blocked by other reservations`}
            style={{ padding:'3px 7px', borderRadius:4, fontSize:8, fontWeight:700,
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-cancel) 55%,transparent)',
              background:'color-mix(in oklch,var(--col-cancel) 14%,transparent)',
              color:'var(--col-cancel)' }}>
            BLOCKED BY OTHERS
          </span>
        )}
        {!blockedAll && blocked > 0 && (
          <span className="mono uc"
            title={`Baseline (no reservations): ${baselineCount} slots — ${blocked} now blocked by other reservations`}
            style={{ padding:'3px 7px', borderRadius:4, fontSize:8, fontWeight:600,
              boxShadow:'inset 0 0 0 1px color-mix(in oklch,var(--col-pending) 55%,transparent)',
              background:'color-mix(in oklch,var(--col-pending) 12%,transparent)',
              color:'var(--col-pending)' }}>
            −{blocked} BLOCKED
          </span>
        )}
        <span className="mono" style={{ fontSize:11, color:'var(--ink-3)', transform: expanded?'rotate(90deg)':'rotate(0deg)', transition:'transform .15s', display:'inline-block', width:12 }}>▸</span>
      </div>

      {/* Per-SP filter row */}
      <div onClick={e => e.stopPropagation()} style={{ padding:'4px 10px 5px 39px', borderTop:'1px solid var(--line-soft)', background:'color-mix(in oklch,var(--ink) 1%,transparent)', display:'flex', gap:6, flexWrap:'wrap', alignItems:'flex-end' }}>
        <AsfInlineSel label="FI"       value={overrides.fi}       onChange={v => onOverrideChange('fi', v)}        opts={fiOpts} />
        <AsfInlineSel label="SE TYPE"  value={overrides.seType}   onChange={v => onOverrideChange('seType', v)}    opts={seTypeOpts} />
        <AsfInlineSel label="DURATION" value={overrides.duration} onChange={v => onOverrideChange('duration', +v)} opts={ASF_DUR_OPTS} />
        <AsfInlineSel label="BUFFER"   value={overrides.gap}      onChange={v => onOverrideChange('gap', +v)}      opts={ASF_GAP_OPTS} />
      </div>

      {/* Expanded: mini-timeline + slot cards */}
      {expanded && (
        <div style={{ padding:'6px 12px 12px 12px', borderTop:'1px solid var(--line-soft)', background:'color-mix(in oklch,var(--ink) 1.5%,transparent)', display:'flex', flexDirection:'column', gap:7 }}>
          {slots.length > 0 && (
            <AsfMiniTimeline
              slots={slots} activatedSlot={activatedSlot}
              windowFrom={windowFrom} windowTo={windowTo}
              rwyStart={rwyStart} rwyEnd={rwyEnd}
              hoveredSlot={hoveredSlot} onSlotHover={onSlotHover}
              hourEnd={hourEnd}
            />
          )}
          {slots.length === 0 ? (
            <div className="mono uc" style={{ fontSize:9, color:'var(--ink-3)', textAlign:'center', padding:'12px 6px' }}>
              No open slots — try a wider window, different FI/type, or another date.
            </div>
          ) : (
            slots.map((slot, i) => {
              const isActive  = activatedSlot?.t === slot.t && activatedSlot?.end === slot.end;
              const isHovered = hoveredSlot?.t === slot.t && hoveredSlot?.end === slot.end;
              return (
                <AsfSlotBtn
                  key={`${slot.t}-${slot.end}-${i}`}
                  slot={slot}
                  isActive={isActive}
                  isHovered={isHovered}
                  activePair={isActive ? { fi: activatedSlot.fi, tail: activatedSlot.tail } : null}
                  onRelease={onRelease}
                  onReservePair={(fi, tail) => onActivate(slot, fi, tail)}
                  onHoverChange={onSlotHover}
                  spName={asfShortName(student.name)}
                  onOpenPicker={() => onOpenPicker(slot, asfShortName(student.name), (fi, tail) => onActivate(slot, fi, tail))}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ─── Root component ───────────────────────────────────────────────────────
function AutoSlotFinderBoard() {
  const { isMobile } = useApp();

  // Persisted user settings (filters, toggles, window, sort) — loaded once on mount
  const saved = useM_asf(() => asfLoadSettings(), []);

  const [asfDate,      setAsfDateRaw]  = useS_asf(DEFAULT_DATE);
  const [acTypeFilter, setAcTypeFilter]= useS_asf(saved.acTypeFilter); // [] = all
  const [windowFrom,   setWindowFrom]  = useS_asf(saved.windowFrom);
  const [windowTo,     setWindowTo]    = useS_asf(saved.windowTo);
  const [rwyEnabled,   setRwyEnabled]  = useS_asf(saved.rwyEnabled);
  const [rwyFrom,      setRwyFrom]     = useS_asf(saved.rwyFrom);
  const [rwyTo,        setRwyTo]       = useS_asf(saved.rwyTo);
  const [topN,         setTopN]        = useS_asf(saved.topN);
  const [sortMode,     setSortMode]    = useS_asf(saved.sortMode);
  const [onlyOpen,     setOnlyOpen]    = useS_asf(saved.onlyOpen);
  const [expanded,     setExpanded]    = useS_asf(new Set());
  const [proposal,     setProposal]    = useS_asf(null);

  const [spOverrides,    setSpOverrides]    = useS_asf({});
  const [activatedSlots, setActivatedSlots] = useS_asf({});
  const [hoveredSlot,    setHoveredSlot]    = useS_asf(null);
  const [fiFilter,       setFiFilter]       = useS_asf(saved.fiFilter); // [] = all
  const [fiMatchSp,      setFiMatchSp]      = useS_asf(saved.fiMatchSp);

  // Export-all "✓ COPIED" feedback flag
  const [exportCopied,   setExportCopied]   = useS_asf(false);

  // Persist settings whenever any tracked piece changes
  useE_asf(() => {
    try {
      localStorage.setItem(ASF_SETTINGS_LS_KEY, JSON.stringify({
        acTypeFilter, fiFilter, fiMatchSp,
        windowFrom, windowTo, rwyEnabled, rwyFrom, rwyTo,
        sortMode, topN, onlyOpen,
      }));
    } catch (_) { /* localStorage unavailable — silently skip */ }
  }, [acTypeFilter, fiFilter, fiMatchSp, windowFrom, windowTo, rwyEnabled, rwyFrom, rwyTo, sortMode, topN, onlyOpen]);

  // Modals
  const [acPickerModal,  setAcPickerModal]  = useS_asf(null); // { slot, spName, onReserve }
  const [tlSlotModal,    setTlSlotModal]    = useS_asf(null); // { slot }
  const [tlReleaseModal, setTlReleaseModal] = useS_asf(null); // act object

  const anyModalOpen = !!(acPickerModal || tlSlotModal || tlReleaseModal || (proposal && proposal.activatedSlot));

  // Open the A/C picker for a specific slot — clears hover first so the timeline
  // doesn't flicker while the backdrop is up.
  const openAcPicker = useC_asf((slot, spName, onReserve) => {
    setHoveredSlot(null);
    setAcPickerModal({ slot, spName, onReserve });
  }, []);

  // Date change releases all reservations
  const setAsfDate = useC_asf(d => {
    setAsfDateRaw(d);
    setActivatedSlots({});
  }, []);

  const cached = useM_asf(() => asfLoadCached(), []);
  const [rankData, setRankData] = useS_asf(cached);
  const [loading,  setLoading]  = useS_asf(false);
  const [fetchErr, setFetchErr] = useS_asf(null);

  const loadRank = useC_asf(async () => {
    setLoading(true); setFetchErr(null);
    try { setRankData(await asfFetchRank()); }
    catch (e) { setFetchErr(e?.message || 'Fetch failed'); }
    finally { setLoading(false); }
  }, []);

  useE_asf(() => {
    if (!cached || (Date.now() - (cached._fetchedAt || 0)) > ASF_LS_MAX_AGE) loadRank();
  }, [loadRank, cached]);

  const dateOpts = useM_asf(() =>
    ALL_DATES.map(d => { const { wd, day, mo } = fmtDay(d); return { v:d, l:`${wd} ${String(day).padStart(2,'0')} ${mo}` }; })
  , []);

  const allAcTypes = useM_asf(() =>
    [...new Set(RESOURCES.filter(r => r.acType && !/SIM|Classroom/i.test(r.acType)).map(r => r.acType))].sort()
  , []);

  const fiOpts = useM_asf(() =>
    [{ v:'Any', l:'Any FI' }, ...SF_AP127_FI_NAMES.sort().map(n => ({ v:n, l:n }))]
  , []);

  const seTypeOpts = useM_asf(() => {
    const types = [...new Set(RESOURCES.filter(r => r.acType && /DA40/i.test(r.acType)).map(r => r.acType))].sort();
    return [{ v:'Any', l:'Any type' }, ...types.map(t => ({ v:t, l:t }))];
  }, []);

  const dateFlights = useM_asf(() =>
    FLIGHTS.filter(f => f.date === asfDate && f.status !== 'Canceled')
  , [asfDate]);

  // Dynamic timeline end: max of 18:00 and the actual last-flight end on this date
  const dynHourEnd = useM_asf(() => {
    const maxMin = dateFlights.reduce((m, f) => {
      const e = minutesOf(f.end); return e != null ? Math.max(m, e) : m;
    }, ASF_HOUR_END * 60);
    return Math.ceil(maxMin / 60);
  }, [dateFlights]);

  const leavesMap   = useM_asf(() => leavesOnDate(asfDate), [asfDate]);
  const tailTypeMap = useM_asf(() => {
    const m = {};
    RESOURCES.forEach(r => { if (r.tail) m[r.tail] = r.acType || ''; });
    return m;
  }, []);

  const fiQuals    = SF_AP127_FI_QUALS;
  const fiAllNames = SF_AP127_FI_NAMES;

  const candidates = useM_asf(() => {
    const typeMatch = fi => acTypeFilter === null || (fiQuals[fi] || []).some(t => acTypeFilter.includes(t));
    const candFIs   = fiAllNames.filter(n =>
      typeMatch(n) && !Object.keys(leavesMap).some(k => k.toLowerCase() === n.toLowerCase()) &&
      (fiFilter === null || fiFilter.includes(n))
    );
    const candTails = RESOURCES.filter(r =>
      r.tail && !r.isMaint && !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === null || acTypeFilter.includes(r.acType))
    ).map(r => r.tail).sort();
    return { candFIs, candTails };
  }, [acTypeFilter, leavesMap, fiFilter]);

  const rwyBand = useM_asf(() => {
    if (!rwyEnabled) return { rwyStart:null, rwyEnd:null };
    return { rwyStart: minutesOf(rwyFrom) ?? null, rwyEnd: minutesOf(rwyTo) ?? null };
  }, [rwyEnabled, rwyFrom, rwyTo]);

  const augmentedFlights = useM_asf(() => {
    const actFlights = Object.entries(activatedSlots).map(([spKey, act]) => ({
      instructor: act.fi, student: spKey, tail: act.tail,
      start: asfMinsToHHMM(act.t), end: asfMinsToHHMM(act.end),
      date: asfDate, status: 'Scheduled',
    }));
    return [...dateFlights, ...actFlights];
  }, [dateFlights, activatedSlots, asfDate]);

  const baseBusyMap = useM_asf(() => asfBuildBusyMap(dateFlights, 0), [dateFlights]);

  const ranked = useM_asf(() => {
    if (!rankData?.ap127) return [];
    const sortFn = sortMode==='leader' ? asfPaceSort : sortMode==='idle' ? asfIdleSort : asfBehindSort;
    const sorted = sortFn(rankData.ap127, asfDate);
    return sorted.map((s, i) => ({ student:s, rank:i+1, rankCls:asfRankClass(i+1, sorted.length), idle:asfIdleDays(s,asfDate) }));
  }, [rankData, asfDate, sortMode]);

  const slotsByStudent = useM_asf(() => {
    if (!ranked.length) return {};
    const wStart = minutesOf(windowFrom);
    const wEnd   = minutesOf(windowTo);
    if (wStart == null || wEnd == null) return {};
    const map = {};
    ranked.forEach(rec => {
      const spKey = asfShortName(rec.student.name);
      // SP on leave → zero slots regardless of other availability
      const spOnLeave = Object.keys(leavesMap).some(k => asfShortName(k).toLowerCase() === spKey.toLowerCase());
      if (spOnLeave) { map[spKey] = []; return; }
      // SP already has a real flight today → no additional slot
      const spHasFlight = dateFlights.some(f => f.student && f.status !== 'Canceled' && asfShortName(f.student).toLowerCase() === spKey.toLowerCase());
      if (spHasFlight) { map[spKey] = []; return; }
      const ovr   = asfGetOverride(spKey, rec.student, spOverrides);
      const dur   = ovr.duration;
      const gap   = ovr.gap;
      if (wEnd <= wStart + dur) return;
      const busyMap     = asfBuildBusyMap(augmentedFlights, gap);
      const spCandFIs   = (!fiMatchSp || ovr.fi === 'Any') ? candidates.candFIs : candidates.candFIs.filter(fi => fi === ovr.fi);
      const spCandTails = ovr.seType === 'Any' ? candidates.candTails : candidates.candTails.filter(tail => tailTypeMap[tail] === ovr.seType);
      const raw = asfFindSlotsForStudent(
        spKey,
        { windowStart:wStart, windowEnd:wEnd, durationMin:dur, ...rwyBand },
        busyMap,
        { candFIs:spCandFIs, candTails:spCandTails, tailTypeMap, fiQuals },
      );
      map[spKey] = asfMergeSlots(raw);
    });
    return map;
  }, [ranked, windowFrom, windowTo, rwyBand, augmentedFlights, dateFlights, candidates, spOverrides, tailTypeMap, fiQuals, fiMatchSp, leavesMap]);

  // Baseline = same slot computation but using ONLY dateFlights (no activated cascade).
  // Used to detect "you blocked yourself out by reserving for someone else" — the
  // per-SP card compares current slots to baseline and shows a chip when reduced.
  // Short-circuits to `slotsByStudent` when no reservations exist (no extra work).
  const baselineSlotsByStudent = useM_asf(() => {
    if (!Object.keys(activatedSlots).length) return slotsByStudent;
    if (!ranked.length) return {};
    const wStart = minutesOf(windowFrom);
    const wEnd   = minutesOf(windowTo);
    if (wStart == null || wEnd == null) return {};
    const map = {};
    ranked.forEach(rec => {
      const spKey = asfShortName(rec.student.name);
      const spOnLeave = Object.keys(leavesMap).some(k => asfShortName(k).toLowerCase() === spKey.toLowerCase());
      if (spOnLeave) { map[spKey] = []; return; }
      // SP already has a real flight today → no additional slot
      const spHasFlight = dateFlights.some(f => f.student && f.status !== 'Canceled' && asfShortName(f.student).toLowerCase() === spKey.toLowerCase());
      if (spHasFlight) { map[spKey] = []; return; }
      const ovr   = asfGetOverride(spKey, rec.student, spOverrides);
      const dur   = ovr.duration;
      const gap   = ovr.gap;
      if (wEnd <= wStart + dur) return;
      const busyMap     = asfBuildBusyMap(dateFlights, gap);
      const spCandFIs   = (!fiMatchSp || ovr.fi === 'Any') ? candidates.candFIs : candidates.candFIs.filter(fi => fi === ovr.fi);
      const spCandTails = ovr.seType === 'Any' ? candidates.candTails : candidates.candTails.filter(tail => tailTypeMap[tail] === ovr.seType);
      const raw = asfFindSlotsForStudent(
        spKey,
        { windowStart:wStart, windowEnd:wEnd, durationMin:dur, ...rwyBand },
        busyMap,
        { candFIs:spCandFIs, candTails:spCandTails, tailTypeMap, fiQuals },
      );
      map[spKey] = asfMergeSlots(raw);
    });
    return map;
  }, [ranked, windowFrom, windowTo, rwyBand, dateFlights, candidates, spOverrides, tailTypeMap, fiQuals, fiMatchSp, activatedSlots, slotsByStudent, leavesMap]);

  const finalRecords = useM_asf(() => {
    const out = ranked.map(rec => {
      const spKey = asfShortName(rec.student.name);
      const slots         = slotsByStudent[spKey] || [];
      const baselineSlots = baselineSlotsByStudent[spKey] || [];
      const leaveKey = Object.keys(leavesMap).find(k => asfShortName(k).toLowerCase() === spKey.toLowerCase());
      const onLeave = leaveKey ? (leavesMap[leaveKey] || 'On Leave') : null;
      const hasFlight = dateFlights.some(f => f.student && f.status !== 'Canceled' && asfShortName(f.student).toLowerCase() === spKey.toLowerCase());
      return { ...rec, slots, baselineCount: baselineSlots.length, onLeave, hasFlight };
    });
    // WITH SLOTS ONLY: hide 0-slot SPs (on-leave, already-scheduled, blocked)
    // but KEEP SPs that already have a reservation so you can see the full picture.
    return (onlyOpen
      ? out.filter(r => r.slots.length > 0 || !!activatedSlots[asfShortName(r.student.name)])
      : out
    ).slice(0, topN);
  }, [ranked, slotsByStudent, baselineSlotsByStudent, onlyOpen, topN, leavesMap, dateFlights, activatedSlots]);

  const stats = useM_asf(() => ({
    openCount:   finalRecords.filter(r => r.slots.length > 0).length,
    totalCombos: finalRecords.reduce((sum, r) => sum + r.slots.reduce((s2, sl) => s2 + sl.pairs.length, 0), 0),
  }), [finalRecords]);

  // FI tab: every instructor who has a flight on this date — not limited to SF_AP127_FI_NAMES
  // so non-AP-127 instructors (AP-124, HP, Recurrent, FAM FI supervisors…) are visible too.
  // FI tab: all instructors in today's flights, filtered by the active fiFilter and
  // acTypeFilter so only relevant rows are shown. FIs with activated reservations are
  // always included regardless of filters so their reserved block stays visible.
  const allFIsForTimeline = useM_asf(() => {
    const actFIs = new Set(Object.values(activatedSlots).map(a => a.fi).filter(Boolean));
    // Always include all AP-127 FIs (even those with no flights today) + any other
    // instructors who appear in today's schedule.
    const ap127FIs = (typeof SF_AP127_FI_NAMES !== 'undefined') ? SF_AP127_FI_NAMES : [];
    const dailyFIs = dateFlights.map(f => f.instructor).filter(Boolean);
    const all = [...new Set([...ap127FIs, ...dailyFIs])];
    const filtered = all.filter(fi => {
      if (actFIs.has(fi)) return true;                           // always show reserved FI
      if (fiFilter !== null && !fiFilter.includes(fi)) return false;  // FI filter
      if (acTypeFilter !== null) {                                // type filter via FI quals
        const quals = fiQuals[fi] || [];
        if (!quals.some(t => acTypeFilter.includes(t))) return false;
      }
      return true;
    });
    return [...new Set(filtered)].sort();
  }, [dateFlights, fiFilter, acTypeFilter, fiQuals, activatedSlots]);

  // A/C tab: every tail that appears in today's flights (non-SIM, matching acTypeFilter)
  // ∪ RESOURCES non-SIM tails filtered by acTypeFilter.
  // Tails with activated reservations are always included.
  const allTailsForTimeline = useM_asf(() => {
    const actTails = new Set(Object.values(activatedSlots).map(a => a.tail).filter(Boolean));
    const s = new Set();
    dateFlights.forEach(f => {
      const t = f.tail;
      if (!t || /\(SIM\)/i.test(t)) return;
      if (actTails.has(t)) { s.add(t); return; }                // always show reserved tail
      if (acTypeFilter !== null && tailTypeMap[t] && !acTypeFilter.includes(tailTypeMap[t])) return;
      s.add(t);
    });
    RESOURCES.filter(r => r.tail && !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === null || acTypeFilter.includes(r.acType))
    ).forEach(r => s.add(r.tail));
    return [...s].sort();
  }, [dateFlights, acTypeFilter, tailTypeMap, activatedSlots]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const toggleExpand  = spKey => setExpanded(prev => { const n = new Set(prev); n.has(spKey) ? n.delete(spKey) : n.add(spKey); return n; });
  const expandAll     = () => setExpanded(new Set(finalRecords.map(r => asfShortName(r.student.name))));
  const collapseAll   = () => setExpanded(new Set());

  const setOverrideField = useC_asf((spKey, field, value) => {
    setSpOverrides(prev => ({ ...prev, [spKey]: { ...(prev[spKey] || {}), [field]: value } }));
  }, []);

  const activateSlot = useC_asf((spKey, spName, t, end, fi, tail) => {
    setActivatedSlots(prev => ({ ...prev, [spKey]: { t, end, fi, tail, spKey, spName } }));
  }, []);

  const releaseSlot = useC_asf(spKey => {
    setActivatedSlots(prev => { const n = { ...prev }; delete n[spKey]; return n; });
  }, []);

  // ── Reset filters / toggles / window to defaults ────────────────────────
  // Clears the localStorage key and snaps every persisted setter back to its
  // built-in default. Does NOT touch reservations, overrides, or hover state.
  const resetSettings = useC_asf(() => {
    try { localStorage.removeItem(ASF_SETTINGS_LS_KEY); } catch (_) {}
    setAcTypeFilter(ASF_DEFAULTS.acTypeFilter);
    setFiFilter(ASF_DEFAULTS.fiFilter);
    setFiMatchSp(ASF_DEFAULTS.fiMatchSp);
    setWindowFrom(ASF_DEFAULTS.windowFrom);
    setWindowTo(ASF_DEFAULTS.windowTo);
    setRwyEnabled(ASF_DEFAULTS.rwyEnabled);
    setRwyFrom(ASF_DEFAULTS.rwyFrom);
    setRwyTo(ASF_DEFAULTS.rwyTo);
    setSortMode(ASF_DEFAULTS.sortMode);
    setTopN(ASF_DEFAULTS.topN);
    setOnlyOpen(ASF_DEFAULTS.onlyOpen);
  }, []);

  // ── Bulk auto-reserve: earliest matched slot per ranked SP ──────────────
  // Walks finalRecords in rank order, picking each SP's earliest available
  // slot and the first FI+tail pair. Each pick is appended to a local
  // augmented flight list so subsequent SPs see the cascade immediately.
  // Final result committed via a single setActivatedSlots() at the end.
  const bulkReserve = useC_asf(() => {
    const wStart = minutesOf(windowFrom);
    const wEnd   = minutesOf(windowTo);
    if (wStart == null || wEnd == null) return;

    const next = {};
    const augmented = [...dateFlights];

    for (const rec of finalRecords) {
      const spKey = asfShortName(rec.student.name);
      // Skip SPs who are on leave or already have a real flight today
      const spOnLeave = Object.keys(leavesMap).some(k => asfShortName(k).toLowerCase() === spKey.toLowerCase());
      if (spOnLeave) continue;
      const spHasFlight = dateFlights.some(f => f.student && f.status !== 'Canceled' && asfShortName(f.student).toLowerCase() === spKey.toLowerCase());
      if (spHasFlight) continue;

      const ovr   = asfGetOverride(spKey, rec.student, spOverrides);
      const dur   = ovr.duration;
      const gap   = ovr.gap;
      if (wEnd <= wStart + dur) continue;

      const busyMap     = asfBuildBusyMap(augmented, gap);
      const spCandFIs   = (!fiMatchSp || ovr.fi === 'Any') ? candidates.candFIs : candidates.candFIs.filter(fi => fi === ovr.fi);
      const spCandTails = ovr.seType === 'Any' ? candidates.candTails : candidates.candTails.filter(t => tailTypeMap[t] === ovr.seType);

      const raw   = asfFindSlotsForStudent(spKey, { windowStart:wStart, windowEnd:wEnd, durationMin:dur, ...rwyBand }, busyMap, { candFIs:spCandFIs, candTails:spCandTails, tailTypeMap, fiQuals });
      const slots = asfMergeSlots(raw);
      if (!slots.length) continue;

      const best = slots[0];           // earliest slot
      const pair = best.pairs[0];      // first FI + tail combo
      next[spKey] = { t:best.t, end:best.end, fi:pair.fi, tail:pair.tail, spKey, spName: asfShortName(rec.student.name) };

      // Inject the virtual flight so the next SP's search sees it as busy
      augmented.push({
        instructor: pair.fi, student: spKey, tail: pair.tail,
        start: asfMinsToHHMM(best.t), end: asfMinsToHHMM(best.end),
        date: asfDate, status: 'Scheduled',
      });
    }
    setActivatedSlots(next);
  }, [finalRecords, dateFlights, windowFrom, windowTo, spOverrides, candidates, tailTypeMap, fiQuals, fiMatchSp, rwyBand, asfDate, leavesMap]);

  // ── Export all reservations as a single dispatcher message ──────────────
  // Builds the text in finalRecords order so it matches the on-screen list.
  // Uses navigator.clipboard.writeText; the ✓ COPIED chip clears after 1.8s.
  const exportAll = useC_asf(async () => {
    const { wd: wdL, day: dayL, mo: moL, y: yL } = fmtDay(asfDate);
    const header = `AP-127 BULK SLOT PROPOSAL — ${wdL} ${String(dayL).padStart(2,'0')} ${moL} ${yL}`;
    const rows = [];
    let idx = 1;
    finalRecords.forEach(rec => {
      const spKey = asfShortName(rec.student.name);
      const act   = activatedSlots[spKey];
      if (!act) return;
      const dur = act.end - act.t;
      const res = RESOURCES.find(r => r.tail === act.tail);
      const acType = res?.acType ? ` (${res.acType})` : '';
      const lesson = rec.student.next_lesson || '—';
      rows.push(`${String(idx).padStart(2,'0')}  ${spKey.padEnd(16,' ')} ${asfMinsToHHMM(act.t)}–${asfMinsToHHMM(act.end)} (${asfFmtDur(dur)})  ${lesson.padEnd(8,' ')}  ${String(act.fi).padEnd(14,' ')} ${act.tail}${acType}`);
      idx++;
    });
    const text = `${header}\n\n${rows.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 1800);
    } catch (_) { /* clipboard may be blocked — fail silently, user can re-try */ }
  }, [finalRecords, activatedSlots, asfDate]);

  const { wd, day, mo } = fmtDay(asfDate);

  const updatedLabel = useM_asf(() => {
    if (!rankData?._updated) return '—';
    try {
      return new Date(rankData._updated)
        .toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Asia/Bangkok' })
        .replace(',', ' ·');
    } catch (_) { return '—'; }
  }, [rankData]);

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle />

      {/* Top bar */}
      <div style={{ minHeight:38, padding:'0 14px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', alignItems:'center', gap:10, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ width:8, height:8, borderRadius:999, background:'var(--highlight)', boxShadow:'0 0 8px var(--highlight)', animation:'pulse 2s ease-in-out infinite' }}/>
          <ViewIcon id="autoslotfinder" size={12} color="var(--ink-2)" />
          <div className="mono uc" style={{ fontSize:11, fontWeight:600 }}>AUTO SLOT FINDER</div>
        </div>
        <div style={{ flex:1 }}/>
        <FocusControls />
        {!isMobile && <div className="mono num" style={{ fontSize:11, color:'var(--ink-3)' }}>{String(day).padStart(2,'0')} {mo} · {wd}</div>}
        <RefreshButton />
        <LastUpdate />
      </div>

      {/* SP info banner */}
      <div style={{ padding:'5px 14px', background:'color-mix(in oklch,var(--col-pending) 5%,var(--bg-2))', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
        <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>SP SOURCE</span>
        <a href="https://ap127cmd.github.io/DB001/" target="_blank" rel="noopener" className="mono" style={{ fontSize:10, color:'var(--col-pending)', textDecoration:'none', fontWeight:600 }}>DB001 ↗</a>
        <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>
          {loading ? 'Loading…' : fetchErr ? `Error: ${fetchErr}` : rankData ? `Updated ${updatedLabel} · ${rankData.ap127?.length||0} SPs` : 'No data yet'}
        </span>
        <span style={{ flex:1 }}/>
        <button onClick={loadRank} disabled={loading} className="mono uc"
          style={{ padding:'3px 10px', fontSize:9, borderRadius:3, cursor: loading?'wait':'pointer',
            border:'1px solid #3b82f6',
            background:'color-mix(in oklch,#3b82f6 14%,transparent)',
            color:'#3b82f6', fontWeight:600 }}>
          {loading ? 'SYNCING…' : '⟳ SYNC SP INFO'}
        </button>
      </div>

      {/* Search strip */}
      <div style={{ padding:'6px 10px 8px', background:'var(--bg-2)', borderBottom:'1px solid var(--line)', display:'flex', gap:8, alignItems:'flex-end', flexWrap:'wrap', flexShrink:0 }}>
        <AsfSel label="DATE" value={asfDate} onChange={setAsfDate} opts={dateOpts} minWidth={130} />
        <AsfMultiCheck label="TYPE" items={allAcTypes.map(t=>({v:t,l:t}))} selected={acTypeFilter} onChange={setAcTypeFilter} allLabel="Any type" color="var(--col-pending)" />
        <AsfSel label="SHOW" value={topN} onChange={v=>setTopN(+v)} opts={ASF_TOPN_OPTS} minWidth={70} />
        <AsfMultiCheck label="FI FILTER" items={fiAllNames.map(n=>({ v:n, l:n, badge: Object.keys(leavesMap).some(k => k.toLowerCase() === n.toLowerCase()) ? 'LEAVE' : null }))} selected={fiFilter} onChange={setFiFilter} allLabel="Any available" color="var(--col-pending)" />
        <div style={{ width:1, height:38, background:'var(--line)', alignSelf:'flex-end', marginBottom:1, flexShrink:0 }}/>
        <AsfTimePicker label="FROM" value={windowFrom} onChange={setWindowFrom} />
        <AsfTimePicker label="TO"   value={windowTo}   onChange={setWindowTo} />
        <label style={{ display:'flex', flexDirection:'column', gap:3 }}>
          <span className="mono uc" style={{ fontSize:9, color:'var(--col-cancel)' }}>RWY CLOSE</span>
          <button onClick={() => setRwyEnabled(v => !v)} className="mono uc"
            style={{ padding:'4px 9px', borderRadius:4, fontSize:10, cursor:'pointer', height:28,
              border:`1px solid ${rwyEnabled?'var(--col-cancel)':'var(--line)'}`,
              background: rwyEnabled?'color-mix(in oklch,var(--col-cancel) 14%,transparent)':'transparent',
              color: rwyEnabled?'var(--col-cancel)':'var(--ink-3)', fontWeight: rwyEnabled?600:400 }}>
            {rwyEnabled ? 'ON' : 'OFF'}
          </button>
        </label>
        {rwyEnabled && (
          <>
            <AsfTimePicker label="CLOSED FROM" value={rwyFrom} onChange={setRwyFrom} accent="var(--col-cancel)" />
            <AsfTimePicker label="CLOSED TO"   value={rwyTo}   onChange={setRwyTo}   accent="var(--col-cancel)" />
          </>
        )}
        <div style={{ display:'flex', flexDirection:'column', gap:3, marginLeft:'auto' }}>
          <span style={{ fontSize:9 }}>&nbsp;</span>
          <div className="mono uc" style={{ padding:'4px 12px', borderRadius:4, fontSize:10, fontWeight:600, height:28, display:'flex', alignItems:'center', border:`1px solid ${stats.openCount>0?'var(--col-done)':'var(--line)'}`, background: stats.openCount>0?'color-mix(in oklch,var(--col-done) 12%,transparent)':'transparent', color: stats.openCount>0?'var(--col-done)':'var(--ink-3)', transition:'all .15s' }}>
            {ranked.length===0 ? 'AWAITING DATA' : `${stats.openCount}/${finalRecords.length} SPS · ${stats.totalCombos} COMBOS`}
          </div>
        </div>
      </div>

      {/* Control row */}
      <div style={{ padding:'5px 12px', background:'var(--bg-2)', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', flexShrink:0 }}>
        <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>RANK BY</span>
        {[['behind','MOST BEHIND'],['idle','LONGEST IDLE'],['leader','LEADER FIRST']].map(([v,lbl]) => (
          <button key={v} onClick={() => setSortMode(v)} className="mono uc"
            style={{ padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
              border:`1px solid ${sortMode===v?'var(--highlight)':'var(--line)'}`,
              background: sortMode===v?'color-mix(in oklch,var(--highlight) 12%,transparent)':'transparent',
              color: sortMode===v?'var(--highlight)':'var(--ink-3)', fontWeight: sortMode===v?600:400 }}>{lbl}</button>
        ))}
        <span style={{ flex:1 }}/>
        {/* AUTO RESERVE — shown only when there are zero active reservations */}
        {Object.keys(activatedSlots).length === 0 && finalRecords.length > 0 && (
          <button onClick={bulkReserve} className="mono uc"
            title="Auto-reserve the earliest matched slot for every ranked SP (cascades through busy map)"
            style={{ padding:'3px 10px', fontSize:8, borderRadius:3, cursor:'pointer',
              border:'1px solid color-mix(in oklch,var(--col-done) 65%,transparent)',
              background:'color-mix(in oklch,var(--col-done) 16%,transparent)',
              color:'var(--col-done)', fontWeight:700 }}>
            ⚡ AUTO RESERVE
          </button>
        )}
        {Object.keys(activatedSlots).length > 0 && (
          <button onClick={exportAll} className="mono uc"
            title="Copy a dispatcher-ready proposal of all reserved slots to clipboard"
            style={{ padding:'3px 10px', fontSize:8, borderRadius:3, cursor:'pointer',
              border:`1px solid ${exportCopied ? 'var(--col-done)' : 'var(--highlight)'}`,
              background: exportCopied ? 'color-mix(in oklch,var(--col-done) 16%,transparent)' : 'color-mix(in oklch,var(--highlight) 14%,transparent)',
              color: exportCopied ? 'var(--col-done)' : 'var(--highlight)', fontWeight:700 }}>
            {exportCopied ? '✓ COPIED' : '📋 EXPORT ALL'}
          </button>
        )}
        {Object.keys(activatedSlots).length > 0 && (
          <button onClick={() => setActivatedSlots({})} className="mono uc"
            style={{ padding:'3px 9px', fontSize:8, borderRadius:3, cursor:'pointer',
              border:'1px solid color-mix(in oklch,var(--col-cancel) 55%,transparent)',
              background:'color-mix(in oklch,var(--col-cancel) 12%,transparent)',
              color:'var(--col-cancel)', fontWeight:600 }}>
            RELEASE ALL ({Object.keys(activatedSlots).length})
          </button>
        )}
        <button onClick={() => setOnlyOpen(v => !v)} className="mono uc"
          style={{ padding:'3px 9px', fontSize:8, borderRadius:3, cursor:'pointer',
            border:`1px solid ${onlyOpen?'var(--col-done)':'var(--line)'}`,
            background: onlyOpen?'color-mix(in oklch,var(--col-done) 14%,transparent)':'transparent',
            color: onlyOpen?'var(--col-done)':'var(--ink-3)', fontWeight: onlyOpen?600:400 }}>WITH SLOTS ONLY</button>
        {/* SP-FI matched toggle */}
        <div style={{ display:'flex', alignItems:'center', gap:5 }}>
          <span className="mono uc" style={{ fontSize:8, color: fiMatchSp ? 'var(--col-done)' : 'var(--ink-3)' }}>SP-FI MATCHED</span>
          <div onClick={() => setFiMatchSp(v => !v)}
            style={{ width:28, height:15, borderRadius:999, cursor:'pointer', transition:'background .15s',
              background: fiMatchSp ? 'var(--col-done)' : 'var(--line)',
              position:'relative', flexShrink:0 }}>
            <div style={{ position:'absolute', top:2, left: fiMatchSp ? 15 : 2, width:11, height:11,
              borderRadius:999, background:'white', transition:'left .15s', boxShadow:'0 1px 3px oklch(0 0 0 / 0.35)' }}/>
          </div>
        </div>
        <button onClick={expandAll}   className="mono uc" style={{ padding:'3px 9px', fontSize:8, borderRadius:3, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)' }}>EXPAND ALL</button>
        <button onClick={collapseAll} className="mono uc" style={{ padding:'3px 9px', fontSize:8, borderRadius:3, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)' }}>COLLAPSE</button>
        <button onClick={resetSettings} className="mono uc"
          title="Reset filters & toggles to defaults (does not touch reservations)"
          style={{ padding:'3px 9px', fontSize:8, borderRadius:3, cursor:'pointer',
            border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)' }}>↺ RESET</button>
      </div>

      {/* Scrollable content — pointer-events and opacity locked while any modal is open
           so hover events on timeline/slot buttons can't fire through the backdrop */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto', pointerEvents: anyModalOpen ? 'none' : 'auto', opacity: anyModalOpen ? 0.45 : 1, transition:'opacity .15s' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:8, padding:'10px' }}>

          {rankData && (
            <AsfTimeline
              baseMap={baseBusyMap}
              allFIs={allFIsForTimeline}
              allTails={allTailsForTimeline}
              windowFrom={windowFrom} windowTo={windowTo}
              rwyStart={rwyBand.rwyStart} rwyEnd={rwyBand.rwyEnd}
              allResults={slotsByStudent}
              activatedSlots={activatedSlots}
              hoveredSlot={hoveredSlot}
              onSlotHover={setHoveredSlot}
              onAvailableSlotClick={slot => setTlSlotModal({ slot })}
              onReservedSlotClick={act => setTlReleaseModal(act)}
              hourEnd={dynHourEnd}
              leavesMap={leavesMap}
              maintTailSet={MAINT_TAILS}
            />
          )}

          {!rankData && loading && (
            <div className="mono uc" style={{ padding:'40px 16px', textAlign:'center', color:'var(--ink-3)', fontSize:10 }}>Fetching AP-127 SP data…</div>
          )}
          {!rankData && !loading && (
            <div style={{ padding:'30px 16px', textAlign:'center' }}>
              <div className="mono uc" style={{ fontSize:10, color:'var(--ink-3)', marginBottom:8 }}>NO SP DATA</div>
              <div style={{ fontSize:10, color:'var(--ink-3)', marginBottom:14 }}>{fetchErr || 'Click SYNC SP INFO to fetch student progress.'}</div>
              <button onClick={loadRank} className="mono uc" style={{ padding:'6px 16px', fontSize:10, borderRadius:4, cursor:'pointer', border:'1px solid #3b82f6', background:'color-mix(in oklch,#3b82f6 14%,transparent)', color:'#3b82f6', fontWeight:600 }}>⟳ SYNC SP INFO</button>
            </div>
          )}
          {rankData && finalRecords.length === 0 && (
            <div className="mono uc" style={{ padding:'30px 16px', textAlign:'center', color:'var(--ink-3)', fontSize:10 }}>
              {onlyOpen ? 'No SP has an open slot — disable WITH SLOTS ONLY or widen the window.' : 'No SPs to show.'}
            </div>
          )}

          {rankData && finalRecords.map(rec => {
            const spKey = asfShortName(rec.student.name);
            const ovr   = asfGetOverride(spKey, rec.student, spOverrides);
            return (
              <AsfStudentCard
                key={spKey}
                rec={rec}
                expanded={expanded.has(spKey)}
                onToggle={() => toggleExpand(spKey)}
                onPropose={() => setProposal({ student: rec.student, activatedSlot: activatedSlots[spKey] })}
                overrides={ovr}
                onOverrideChange={(field, value) => setOverrideField(spKey, field, value)}
                activatedSlot={activatedSlots[spKey] || null}
                onActivate={(slot, fi, tail) => activateSlot(spKey, asfShortName(rec.student.name), slot.t, slot.end, fi, tail)}
                onRelease={() => releaseSlot(spKey)}
                fiOpts={fiOpts}
                seTypeOpts={seTypeOpts}
                windowFrom={windowFrom} windowTo={windowTo}
                rwyStart={rwyBand.rwyStart} rwyEnd={rwyBand.rwyEnd}
                hoveredSlot={hoveredSlot}
                onSlotHover={setHoveredSlot}
                hourEnd={dynHourEnd}
                onOpenPicker={openAcPicker}
              />
            );
          })}
        </div>
      </div>

      {/* Modals — all rendered at board level so their fixed backdrops are never
           nested inside interactive content divs (prevents hover-flicker). */}
      {acPickerModal && (
        <AsfAcPickerModal
          slot={acPickerModal.slot}
          spName={acPickerModal.spName}
          onReserve={acPickerModal.onReserve}
          onClose={() => setAcPickerModal(null)}
        />
      )}
      {proposal && proposal.activatedSlot && (
        <AsfProposeModal
          student={proposal.student}
          activatedSlot={proposal.activatedSlot}
          dateStr={asfDate}
          onClose={() => setProposal(null)}
        />
      )}
      {tlSlotModal && (
        <AsfTimelineSlotModal
          slot={tlSlotModal.slot}
          slotsByStudent={slotsByStudent}
          ranked={ranked}
          activatedSlots={activatedSlots}
          onReserve={(spKey, spName, t, end, fi, tail) => activateSlot(spKey, spName, t, end, fi, tail)}
          onClose={() => setTlSlotModal(null)}
        />
      )}
      {tlReleaseModal && (
        <AsfTimelineReleaseModal
          act={tlReleaseModal}
          onRelease={releaseSlot}
          onClose={() => setTlReleaseModal(null)}
        />
      )}

      <Drawer />
    </ArtboardShell>
  );
}

window.AutoSlotFinderBoard = AutoSlotFinderBoard;
