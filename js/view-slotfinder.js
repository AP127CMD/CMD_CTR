// SLOT FINDER — find open time windows for an additional AP-127 flight
// Round 21: buffer both-sides fix, multi-checkbox FI/SP, hard-coded SP names, 06:30 default
const { useMemo: useM_sf, useState: useS_sf } = React;

// ─── AP-127 FI Qualification Map ─────────────────────────────────────────
const SF_AP127_FI_QUALS = {
  'CHAROENCHAI U.': ['DA40CS', 'DA42TDI'],
  'EKKAPHOP R.':    ['DA40TDI', 'DA42TDI'],
  'ITTIPOL P.':     ['DA40TDI', 'DA42TDI'],
  'KITTICHAI C.':   ['DA40CS', 'DA42TDI'],
  'KOONPHOL U.':    ['DA40CS', 'DA42TDI'],
  'NAPATTORN S.':   ['DA40TDI', 'DA42TDI'],
  'PARINYA B.':     ['DA40CS', 'DA42TDI'],
  'PHAHOLYUTH P.':  ['DA40CS', 'DA42TDI'],
  'SANTI PO.':      ['DA40CS', 'DA42TDI'],
  'SANTI SUK.':     ['DA40CS', 'DA42TDI'],
  'SOWAN C.':       ['DA40CS', 'DA42TDI'],
  'THAWATANAN P.':  ['DA40TDI', 'DA42TDI'],
  'WISANU T.':      ['DA40TDI', 'DA42TDI'],
  'WUTTHICHAI L.':  ['DA40TDI', 'DA42TDI'],
};
const SF_AP127_FI_NAMES = Object.keys(SF_AP127_FI_QUALS).sort();

// ─── AP-127 SP names (hard-coded, alphabetical) ──────────────────────────
const SF_AP127_SP_NAMES = [
  'Akaravit K.',    'Anusorn T.',      'Awirut S.',
  'Bulaset C.',     'Jirayu A.',       'Khobpong W.',
  'Kitthanya T.',   'Korn S.',         'Kraisee L.',
  'Krit L.',        'Maethaphan R.',   'Napon S.',
  'Natpakalp K.',   'Nuttaphat K.',    'Panithan V.',
  'Pichakorn J.',   'Pornskul D.',     'Puwadet H.',
  'Setasit P.',     'Siwakorn P.',     'Sornsorawitch C.',
  'Supawan A.',     'Takorn C.',       'Teerawaj C.',
  'Vasaphon S.',    'Watcharaphol V.', 'Watcharapol A.',
  'Watcharapong C.',
];

// ─── Static option arrays ─────────────────────────────────────────────────
// Duration: 1:00 – 5:00 in 15-min steps
const SF_DUR_OPTS = (() => {
  const o = [];
  for (let m = 60; m <= 300; m += 15) {
    o.push({ v: m, l: `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}` });
  }
  return o;
})();

// Buffer: 0 – 60 min in 5-min steps, default 30
const SF_GAP_OPTS = (() => {
  const o = [];
  for (let m = 0; m <= 60; m += 5) {
    o.push({ v: m, l: m === 0 ? 'No buffer' : `${m} min` });
  }
  return o;
})();

// ─── Constants ────────────────────────────────────────────────────────────
const SF_HOUR_START = 6;
const SF_HOUR_END   = 18;
const SF_HOUR_SPAN  = SF_HOUR_END - SF_HOUR_START;
const SF_MAX_DUTY   = 420; // 7 h in minutes

// ─── Pure helpers ─────────────────────────────────────────────────────────
const sfMinsToHHMM = m =>
  m == null ? '—' : `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

const sfFmtDur = m => {
  const h = Math.floor(m/60), mm = m%60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
};

function sfHasOverlap(blocks, t, end) {
  if (!blocks?.length) return false;
  for (let i = 0; i < blocks.length; i++)
    if (t < blocks[i].end && end > blocks[i].start) return true;
  return false;
}

function sfDutyOk(duty, t, end) {
  if (!duty) return true;
  return (Math.max(duty.last, end) - Math.min(duty.first, t)) <= SF_MAX_DUTY;
}

// Build padded busy-block maps — BOTH SIDES: every flight padded by gapMin
// on both its start and end. This is the correct "minimum gap to neighbouring
// flights" behaviour users expect from a buffer/separation control.
function sfBuildBusyMap(dateFlights, gapMin) {
  const rawFI = {}, rawSP = {}, rawTail = {};
  const fiDuty = {};

  dateFlights.forEach(f => {
    const s = minutesOf(f.start), e = minutesOf(f.end);
    if (s == null || e == null) return;
    const push = (map, key) => { if (key) (map[key] = map[key] || []).push({ s, e }); };
    push(rawFI,   f.instructor);
    push(rawSP,   f.student);
    push(rawTail, f.tail);
    if (f.instructor) {
      const d = fiDuty[f.instructor];
      if (!d) fiDuty[f.instructor] = { first: s, last: e };
      else { d.first = Math.min(d.first, s); d.last = Math.max(d.last, e); }
    }
  });

  // Both-sides padding: expand every flight block by gapMin on both sides
  const toBusy = rawMap => {
    const out = {};
    Object.entries(rawMap).forEach(([key, arr]) => {
      out[key] = arr.map(({ s, e }) => ({ start: s - gapMin, end: e + gapMin }));
    });
    return out;
  };

  return {
    fiBusy:   toBusy(rawFI),
    spBusy:   toBusy(rawSP),
    tailBusy: toBusy(rawTail),
    fiDuty,
    rawFI,   // un-padded originals for timeline rendering
    rawTail,
  };
}

// Sweep in 15-min steps; for each slot emit valid (FI × tail) pairs and
// the list of free SPs (from those selected, if any).
function sfRunFinder(
  { windowStart, windowEnd, durationMin, spSelected, rwyStart, rwyEnd },
  { fiBusy, spBusy, tailBusy, fiDuty },
  { candFIs, candTails, tailTypeMap }
) {
  const results = [];
  for (let t = windowStart; t <= windowEnd - durationMin; t += 15) {
    const end = t + durationMin;

    // RWY close check — slot must not overlap the closure window
    if (rwyStart != null && rwyEnd != null && t < rwyEnd && end > rwyStart) continue;

    // SP constraint — at least one selected SP must be free
    let freeSPs = null;
    if (spSelected.length > 0) {
      freeSPs = spSelected.filter(sp => !sfHasOverlap(spBusy[sp], t, end));
      if (!freeSPs.length) continue;
    }

    // Free FIs and aircraft
    const freeFIs   = candFIs.filter(fi =>
      !sfHasOverlap(fiBusy[fi], t, end) && sfDutyOk(fiDuty[fi], t, end)
    );
    const freeTails = candTails.filter(tail => !sfHasOverlap(tailBusy[tail], t, end));
    if (!freeFIs.length || !freeTails.length) continue;

    // Build type-qualified pairs
    const pairs = [];
    for (const fi of freeFIs) {
      const quals = SF_AP127_FI_QUALS[fi] || [];
      for (const tail of freeTails)
        if (quals.includes(tailTypeMap[tail])) pairs.push({ fi, tail });
    }
    if (!pairs.length) continue;

    results.push({ t, end, pairs, freeSPs });
  }
  return results;
}

// Merge consecutive 15-min slots that share the same (FI set × tail set × free-SP set)
function sfMergeSlots(rawSlots) {
  if (!rawSlots.length) return [];
  const makeKey = slot => {
    const fis  = [...new Set(slot.pairs.map(p => p.fi))].sort().join('|');
    const tls  = [...new Set(slot.pairs.map(p => p.tail))].sort().join('|');
    const sps  = slot.freeSPs ? [...slot.freeSPs].sort().join('|') : '';
    return `${fis}##${tls}##${sps}`;
  };
  const windows = [];
  let cur = null;
  rawSlots.forEach(slot => {
    const key = makeKey(slot);
    if (cur && cur._key === key && slot.t === cur.end) {
      cur.end = slot.end;
    } else {
      if (cur) windows.push(cur);
      cur = { ...slot, _key: key };
    }
  });
  if (cur) windows.push(cur);
  return windows.map(({ _key, ...w }) => w);
}

// ─── Multi-checkbox dropdown ───────────────────────────────────────────────
// items: [{v, l}]  selected: string[]  onChange: (string[]) => void
function SfMultiCheck({ label, items, selected, onChange, allLabel, color }) {
  const [open, setOpen] = React.useState(false);

  const toggle = v =>
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);

  const displayLabel = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;

  const accentColor = color || 'var(--col-pending)';

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3, position:'relative' }}>
      <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>{label}</span>

      {/* Trigger button */}
      <button onClick={() => setOpen(o => !o)} className="mono"
        style={{
          display:'flex', alignItems:'center', gap:5,
          background:'var(--surface)', color: selected.length > 0 ? accentColor : 'var(--ink-2)',
          border: `1px solid ${selected.length > 0
            ? `color-mix(in oklch,${accentColor} 55%,transparent)`
            : 'var(--line)'}`,
          borderRadius:4, padding:'4px 8px', fontSize:11, outline:'none',
          cursor:'pointer', textAlign:'left', minWidth:148, height:28,
        }}>
        <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {displayLabel}
        </span>
        {selected.length > 0 && (
          <span style={{
            background:`color-mix(in oklch,${accentColor} 20%,transparent)`,
            color: accentColor, borderRadius:999, fontSize:8,
            padding:'0 5px', lineHeight:'16px', flexShrink:0,
          }}>{selected.length}</span>
        )}
        <span style={{ fontSize:7, color:'var(--ink-3)', flexShrink:0 }}>▾</span>
      </button>

      {open && (
        <>
          {/* Backdrop — closes on click outside */}
          <div style={{ position:'fixed', inset:0, zIndex:49 }} onClick={() => setOpen(false)} />

          {/* Panel */}
          <div style={{
            position:'absolute', top:'calc(100% + 3px)', left:0, zIndex:50,
            background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius:6,
            boxShadow:'0 8px 28px oklch(0 0 0 / 0.45)',
            minWidth:192, maxHeight:300, display:'flex', flexDirection:'column',
            overflow:'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding:'5px 8px', borderBottom:'1px solid var(--line-soft)',
              display:'flex', alignItems:'center', gap:6,
            }}>
              <button onClick={() => { onChange([]); setOpen(false); }} className="mono uc"
                style={{
                  flex:1, padding:'3px 0', fontSize:8, borderRadius:3,
                  border:`1px solid ${selected.length === 0 ? accentColor : 'var(--line)'}`,
                  background: selected.length === 0
                    ? `color-mix(in oklch,${accentColor} 12%,transparent)` : 'transparent',
                  color: selected.length === 0 ? accentColor : 'var(--ink-3)',
                  fontWeight: selected.length === 0 ? 600 : 400, cursor:'pointer',
                }}>ALL</button>
              {selected.length > 0 && (
                <button onClick={() => onChange([])} className="mono uc"
                  style={{
                    padding:'3px 8px', fontSize:8, borderRadius:3,
                    border:'1px solid var(--col-cancel)',
                    background:'color-mix(in oklch,var(--col-cancel) 10%,transparent)',
                    color:'var(--col-cancel)', cursor:'pointer',
                  }}>CLEAR</button>
              )}
            </div>

            {/* Checkboxes */}
            <div style={{ overflowY:'auto', flex:1 }}>
              {items.map(item => {
                const checked = selected.includes(item.v);
                return (
                  <label key={item.v} onClick={() => toggle(item.v)}
                    style={{
                      display:'flex', alignItems:'center', gap:8,
                      padding:'5px 10px', cursor:'pointer',
                      background: checked
                        ? `color-mix(in oklch,${accentColor} 10%,transparent)`
                        : 'transparent',
                    }}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(item.v)}
                      onClick={e => e.stopPropagation()}
                      style={{ accentColor: accentColor, flexShrink:0, cursor:'pointer' }} />
                    <span className="mono" style={{ fontSize:10, color:'var(--ink)', userSelect:'none' }}>
                      {item.l}
                    </span>
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

// ─── Simple select ─────────────────────────────────────────────────────────
function SfSel({ label, value, onChange, opts, minWidth }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:3 }}>
      <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>{label}</span>
      <select className="mono" value={value} onChange={e => onChange(e.target.value)}
        style={{
          background:'var(--surface)', color:'var(--ink)',
          border:'1px solid var(--line)', borderRadius:4,
          padding:'4px 8px', fontSize:11, outline:'none',
          minWidth: minWidth || 90, height:28,
        }}>
        {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

// ─── Time input ───────────────────────────────────────────────────────────
function SfTimeInput({ label, value, onChange, accent }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:3 }}>
      {label && (
        <span className="mono uc" style={{ fontSize:9, color: accent || 'var(--ink-3)' }}>{label}</span>
      )}
      <input type="time" value={value} onChange={e => onChange(e.target.value)}
        className="mono"
        style={{
          background:'var(--surface)', color:'var(--ink)',
          border:`1px solid ${accent
            ? `color-mix(in oklch,${accent} 40%,var(--line))`
            : 'var(--line)'}`,
          borderRadius:4, padding:'4px 8px', fontSize:11, outline:'none',
          fontFamily:'inherit', width:80, height:28,
        }} />
    </label>
  );
}

// ─── Slot result card ──────────────────────────────────────────────────────
function SfSlotCard({ slot }) {
  // Group pairs by FI, sorted alphabetically; each FI's tails sorted
  const byFI = {};
  slot.pairs.forEach(({ fi, tail }) => { (byFI[fi] = byFI[fi] || []).push(tail); });
  const fiEntries = Object.entries(byFI).sort(([a],[b]) => a.localeCompare(b));

  const nCombos = slot.pairs.length;
  const nFIs    = fiEntries.length;
  const nTails  = new Set(slot.pairs.map(p => p.tail)).size;
  const accent  = nCombos >= 6 ? 'var(--col-done)'
                : nCombos >= 3 ? 'var(--col-pending)'
                :                'var(--col-cancel)';
  const badge   = nCombos >= 6 ? 'OPEN' : nCombos >= 3 ? 'LIMITED' : 'TIGHT';

  return (
    <div style={{
      background:`linear-gradient(to right, ${accent} 3px, var(--surface) 3px)`,
      boxShadow:`inset 0 0 0 1px color-mix(in oklch,${accent} 22%,var(--line))`,
      borderRadius:6, padding:'9px 12px',
      display:'flex', flexDirection:'column', gap:7,
    }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <span className="mono num" style={{ fontSize:15, fontWeight:700, color:'var(--ink)' }}>
          {sfMinsToHHMM(slot.t)} – {sfMinsToHHMM(slot.end)}
        </span>
        <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>
          {sfFmtDur(slot.end - slot.t)}
        </span>
        <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>
          · {nFIs} FI{nFIs>1?'s':''} · {nTails} A/C
        </span>
        <span style={{ flex:1 }} />
        <span className="mono" style={{ fontSize:11, fontWeight:700, color:accent }}>
          {nCombos}&thinsp;COMBO{nCombos>1?'S':''}
        </span>
        <span className="mono uc" style={{
          fontSize:8, padding:'2px 7px', borderRadius:999,
          background:`color-mix(in oklch,${accent} 14%,transparent)`,
          border:`1px solid color-mix(in oklch,${accent} 35%,transparent)`,
          color:accent,
        }}>{badge}</span>
      </div>

      {/* FI × Aircraft pairs */}
      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
        {fiEntries.map(([fi, tails]) => (
          <div key={fi} style={{ display:'flex', alignItems:'flex-start', gap:8, flexWrap:'wrap' }}>
            <span style={{
              fontSize:10, color:'var(--ink-2)',
              minWidth:138, flexShrink:0, paddingTop:2,
            }}>{fi}</span>
            <div style={{ display:'flex', gap:4, flexWrap:'wrap', flex:1 }}>
              {[...tails].sort().map(tail => {
                const res = RESOURCES.find(r => r.tail === tail);
                return (
                  <span key={tail} className="mono" style={{
                    fontSize:9, padding:'2px 8px', borderRadius:4,
                    background:'color-mix(in oklch,var(--col-done) 10%,transparent)',
                    border:'1px solid color-mix(in oklch,var(--col-done) 28%,transparent)',
                    color:'var(--col-done)',
                  }}>{tail}{res?.acType ? ` · ${res.acType}` : ''}</span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Free SPs (when constrained) */}
      {slot.freeSPs && slot.freeSPs.length > 0 && (
        <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
          <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', minWidth:22 }}>SP</span>
          {slot.freeSPs.map(sp => (
            <span key={sp} className="mono" style={{
              fontSize:9, padding:'2px 8px', borderRadius:4,
              background:'color-mix(in oklch,oklch(0.72 0.15 280) 12%,transparent)',
              border:'1px solid color-mix(in oklch,oklch(0.72 0.15 280) 30%,transparent)',
              color:'oklch(0.72 0.15 280)',
            }}>{sp}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Resource timeline ─────────────────────────────────────────────────────
function SfTimeline({
  busyMap, allFIs, candFIs, allTails, candTails,
  results, windowFrom, windowTo, leavesMap, rwyStart, rwyEnd,
}) {
  const LABEL_W  = 155;
  const BASE_MIN = SF_HOUR_START * 60;
  const SPAN_MIN = SF_HOUR_SPAN  * 60;

  const pct  = m  => `${Math.max(0, Math.min(100, ((m - BASE_MIN) / SPAN_MIN) * 100))}%`;
  const wpct = dm => `${Math.max(0, (dm / SPAN_MIN) * 100)}%`;

  const wStart = minutesOf(windowFrom) ?? BASE_MIN;
  const wEnd   = minutesOf(windowTo)   ?? (BASE_MIN + SPAN_MIN);
  const { rawFI, rawTail } = busyMap;

  const avFISet   = new Set(results.flatMap(s => s.pairs.map(p => p.fi)));
  const avTailSet = new Set(results.flatMap(s => s.pairs.map(p => p.tail)));
  const candFISet   = new Set(candFIs);
  const candTailSet = new Set(candTails);

  const sections = [
    { label:'FLIGHT INSTRUCTORS', rows:[...allFIs].sort(),   raw:rawFI,   avSet:avFISet,   candSet:candFISet },
    { label:'AIRCRAFT',           rows:[...allTails].sort(), raw:rawTail, avSet:avTailSet, candSet:candTailSet },
  ];

  return (
    <div style={{
      border:'1px solid var(--line)', borderRadius:6,
      overflow:'hidden', background:'var(--surface)', flexShrink:0,
    }}>
      {/* Hour ruler */}
      <div style={{
        display:'grid', gridTemplateColumns:`${LABEL_W}px 1fr`,
        background:'var(--bg-2)', borderBottom:'1px solid var(--line)', height:26,
      }}>
        <div className="mono uc" style={{
          padding:'0 10px', fontSize:8, color:'var(--ink-3)',
          display:'flex', alignItems:'center',
        }}>TIMELINE</div>
        <div style={{ position:'relative' }}>
          {/* Search window */}
          <div style={{
            position:'absolute',
            left:pct(Math.max(BASE_MIN, wStart)),
            width:wpct(Math.min(BASE_MIN+SPAN_MIN, wEnd) - Math.max(BASE_MIN, wStart)),
            top:0, bottom:0,
            background:'color-mix(in oklch,var(--col-pending) 8%,transparent)',
          }}/>
          {/* RWY close */}
          {rwyStart != null && rwyEnd != null && (
            <div style={{
              position:'absolute',
              left:pct(Math.max(BASE_MIN, rwyStart)),
              width:wpct(Math.min(BASE_MIN+SPAN_MIN, rwyEnd) - Math.max(BASE_MIN, rwyStart)),
              top:0, bottom:0,
              background:'color-mix(in oklch,var(--col-cancel) 18%,transparent)',
              borderLeft:'1px solid color-mix(in oklch,var(--col-cancel) 40%,transparent)',
              borderRight:'1px solid color-mix(in oklch,var(--col-cancel) 40%,transparent)',
            }}/>
          )}
          {Array.from({ length: SF_HOUR_SPAN+1 }, (_,i) => (
            <div key={i} className="mono num" style={{
              position:'absolute', left:pct((SF_HOUR_START+i)*60), top:0, bottom:0,
              borderLeft: i===0?'none':'1px solid var(--line-soft)',
              paddingLeft:3, fontSize:9, color:'var(--ink-3)',
              display:'flex', alignItems:'center',
            }}>{SF_HOUR_START+i}</div>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div style={{ maxHeight:320, overflowY:'auto' }}>
        {sections.map(({ label, rows, raw, avSet, candSet }) => (
          <React.Fragment key={label}>
            <div className="mono uc" style={{
              fontSize:8, color:'var(--ink-3)', padding:'3px 10px',
              background:'color-mix(in oklch,var(--ink) 4%,var(--surface))',
              borderBottom:'1px solid var(--line-soft)',
            }}>{label}</div>

            {rows.map((rowKey, ri) => {
              const flights  = raw[rowKey] || [];
              const isLeave  = leavesMap?.[rowKey];
              const inCand   = candSet.has(rowKey);
              const hasSlots = avSet.has(rowKey);

              return (
                <div key={rowKey} style={{
                  display:'grid', gridTemplateColumns:`${LABEL_W}px 1fr`,
                  borderBottom:'1px solid var(--line-soft)', minHeight:32,
                  background: ri%2 ? 'transparent'
                    : 'color-mix(in oklch,var(--ink) 1.5%,transparent)',
                  opacity: (isLeave || !inCand) ? 0.28 : 1,
                  transition:'opacity .15s',
                }}>
                  <div style={{
                    padding:'0 8px', display:'flex', alignItems:'center', gap:5,
                    borderRight:'1px solid var(--line)', overflow:'hidden',
                  }}>
                    <span style={{
                      fontSize:10,
                      color: hasSlots ? 'var(--ink)' : 'var(--ink-2)',
                      fontWeight: hasSlots ? 600 : 400,
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1,
                    }}>{rowKey}</span>
                    {isLeave && (
                      <span className="mono uc" style={{
                        fontSize:7, padding:'1px 4px', borderRadius:3, flexShrink:0,
                        background:'color-mix(in oklch,oklch(0.7 0.14 260) 15%,transparent)',
                        border:'1px solid color-mix(in oklch,oklch(0.7 0.14 260) 40%,transparent)',
                        color:'oklch(0.7 0.14 260)',
                      }}>LEAVE</span>
                    )}
                  </div>

                  <div style={{ position:'relative' }}>
                    {Array.from({ length:SF_HOUR_SPAN }, (_,i) => (
                      <div key={i} style={{
                        position:'absolute', left:pct((SF_HOUR_START+i)*60),
                        top:0, bottom:0,
                        borderLeft:'1px solid var(--line-soft)', opacity:0.35,
                        pointerEvents:'none',
                      }}/>
                    ))}
                    {/* search window tint */}
                    <div style={{
                      position:'absolute',
                      left:pct(Math.max(BASE_MIN, wStart)),
                      width:wpct(Math.min(BASE_MIN+SPAN_MIN, wEnd) - Math.max(BASE_MIN, wStart)),
                      top:0, bottom:0,
                      background:'color-mix(in oklch,var(--col-pending) 5%,transparent)',
                      pointerEvents:'none',
                    }}/>
                    {/* RWY close tint */}
                    {rwyStart != null && rwyEnd != null && (
                      <div style={{
                        position:'absolute',
                        left:pct(Math.max(BASE_MIN, rwyStart)),
                        width:wpct(Math.min(BASE_MIN+SPAN_MIN, rwyEnd) - Math.max(BASE_MIN, rwyStart)),
                        top:0, bottom:0,
                        background:'color-mix(in oklch,var(--col-cancel) 8%,transparent)',
                        pointerEvents:'none',
                      }}/>
                    )}
                    {/* Existing flights (un-padded raw) */}
                    {flights.map((fl, fi) => (
                      <div key={fi} style={{
                        position:'absolute',
                        left:pct(Math.max(BASE_MIN, fl.s)),
                        width:wpct(Math.min(BASE_MIN+SPAN_MIN, fl.e) - Math.max(BASE_MIN, fl.s)),
                        top:4, bottom:4,
                        background:'color-mix(in oklch,var(--ink-2) 28%,transparent)',
                        border:'1px solid color-mix(in oklch,var(--ink-2) 45%,transparent)',
                        borderRadius:3,
                      }}/>
                    ))}
                    {/* Available slot highlights */}
                    {results.map((slot, si) => {
                      const inPairs = label === 'FLIGHT INSTRUCTORS'
                        ? slot.pairs.some(p => p.fi   === rowKey)
                        : slot.pairs.some(p => p.tail === rowKey);
                      if (!inPairs) return null;
                      return (
                        <div key={si} style={{
                          position:'absolute',
                          left:pct(Math.max(BASE_MIN, slot.t)),
                          width:wpct(slot.end - slot.t),
                          top:5, bottom:5,
                          background:'color-mix(in oklch,var(--col-done) 22%,transparent)',
                          border:'1px solid color-mix(in oklch,var(--col-done) 55%,transparent)',
                          borderRadius:3, pointerEvents:'none',
                        }}/>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>

      {/* Legend */}
      <div style={{
        display:'flex', gap:14, padding:'4px 10px', flexWrap:'wrap',
        borderTop:'1px solid var(--line-soft)',
        background:'color-mix(in oklch,var(--ink) 2%,var(--surface))',
      }}>
        {[
          ['color-mix(in oklch,var(--ink-2) 28%,transparent)',    'Scheduled'],
          ['color-mix(in oklch,var(--col-done) 22%,transparent)', 'Available slot'],
          ['color-mix(in oklch,var(--col-pending) 8%,transparent)','Search window'],
          ['color-mix(in oklch,var(--col-cancel) 18%,transparent)','RWY closed'],
        ].map(([bg, lbl]) => (
          <div key={lbl} style={{ display:'flex', alignItems:'center', gap:4 }}>
            <div style={{ width:12, height:8, borderRadius:2, background:bg }}/>
            <span className="mono" style={{ fontSize:8, color:'var(--ink-3)' }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Root component ────────────────────────────────────────────────────────
function SlotFinderBoard() {
  const { isMobile } = useApp();

  // ── Search params ─────────────────────────────────────────────────────
  const [sfDate,       setSfDate]       = useS_sf(DEFAULT_DATE);
  const [durationMin,  setDurationMin]  = useS_sf(60);
  const [gapMin,       setGapMin]       = useS_sf(30);
  const [acTypeFilter, setAcTypeFilter] = useS_sf('Any');
  const [fiSelected,   setFiSelected]   = useS_sf([]);   // [] = all AP127 FIs
  const [spSelected,   setSpSelected]   = useS_sf([]);   // [] = no constraint
  const [windowFrom,   setWindowFrom]   = useS_sf('06:30');  // ← default 06:30
  const [windowTo,     setWindowTo]     = useS_sf('18:00');
  const [sortBy,       setSortBy]       = useS_sf('earliest');
  const [rwyEnabled,   setRwyEnabled]   = useS_sf(true);
  const [rwyFrom,      setRwyFrom]      = useS_sf('14:00');
  const [rwyTo,        setRwyTo]        = useS_sf('16:00');

  // ── Dropdown option lists ─────────────────────────────────────────────
  const dateOpts = useM_sf(() =>
    ALL_DATES.map(d => {
      const { wd, day, mo } = fmtDay(d);
      return { v:d, l:`${wd} ${String(day).padStart(2,'0')} ${mo}` };
    })
  , []);

  const typeOpts = useM_sf(() => {
    const types = [...new Set(
      RESOURCES.filter(r => r.acType && !/SIM|Classroom/i.test(r.acType)).map(r => r.acType)
    )].sort();
    return [{ v:'Any', l:'Any type' }, ...types.map(t => ({ v:t, l:t }))];
  }, []);

  // FI items for multi-check (filtered by type)
  const fiItems = useM_sf(() => {
    const qualified = acTypeFilter === 'Any'
      ? SF_AP127_FI_NAMES
      : SF_AP127_FI_NAMES.filter(n => SF_AP127_FI_QUALS[n]?.includes(acTypeFilter));
    return qualified.map(n => ({ v:n, l:n }));
  }, [acTypeFilter]);

  // SP items: hard-coded AP127 names
  const spItems = SF_AP127_SP_NAMES.map(n => ({ v:n, l:n }));

  // ── Date-derived memos ────────────────────────────────────────────────
  const dateFlights = useM_sf(() =>
    FLIGHTS.filter(f => f.date === sfDate && f.status !== 'Canceled')
  , [sfDate]);

  const leavesMap = useM_sf(() => leavesOnDate(sfDate), [sfDate]);

  const busyMap = useM_sf(() => sfBuildBusyMap(dateFlights, gapMin), [dateFlights, gapMin]);

  const tailTypeMap = useM_sf(() => {
    const m = {};
    RESOURCES.forEach(r => { if (r.tail) m[r.tail] = r.acType || ''; });
    return m;
  }, []);

  // Candidate FIs: multi-selected (or all if empty), type-qualified, not on leave
  const candidates = useM_sf(() => {
    const typeMatch = fi => acTypeFilter === 'Any' || SF_AP127_FI_QUALS[fi]?.includes(acTypeFilter);

    const pool = fiSelected.length > 0 ? fiSelected : SF_AP127_FI_NAMES;
    const candFIs = pool.filter(n => typeMatch(n) && !leavesMap[n]);

    const candTails = RESOURCES.filter(r =>
      r.tail && !r.isMaint &&
      !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === 'Any' || r.acType === acTypeFilter)
    ).map(r => r.tail).sort();

    return { candFIs, candTails, tailTypeMap };
  }, [fiSelected, acTypeFilter, leavesMap, tailTypeMap]);

  const allTailsForTimeline = useM_sf(() =>
    RESOURCES.filter(r =>
      r.tail && !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === 'Any' || r.acType === acTypeFilter)
    ).map(r => r.tail).sort()
  , [acTypeFilter]);

  const rwyBand = useM_sf(() => {
    if (!rwyEnabled) return { rwyStart:null, rwyEnd:null };
    return { rwyStart: minutesOf(rwyFrom) ?? null, rwyEnd: minutesOf(rwyTo) ?? null };
  }, [rwyEnabled, rwyFrom, rwyTo]);

  // ── Core search ───────────────────────────────────────────────────────
  const rawResults = useM_sf(() => {
    const wStart = minutesOf(windowFrom);
    const wEnd   = minutesOf(windowTo);
    if (wStart == null || wEnd == null || wEnd <= wStart + durationMin) return [];
    return sfRunFinder(
      { windowStart:wStart, windowEnd:wEnd, durationMin, spSelected, ...rwyBand },
      busyMap, candidates,
    );
  }, [windowFrom, windowTo, durationMin, spSelected, rwyBand, busyMap, candidates]);

  const mergedResults = useM_sf(() => sfMergeSlots(rawResults), [rawResults]);

  const sortedResults = useM_sf(() => {
    const arr = [...mergedResults];
    if (sortBy === 'most-combos') arr.sort((a,b) => b.pairs.length - a.pairs.length);
    if (sortBy === 'most-fi')
      arr.sort((a,b) => new Set(b.pairs.map(p=>p.fi)).size - new Set(a.pairs.map(p=>p.fi)).size);
    return arr;
  }, [mergedResults, sortBy]);

  const { wd, day, mo } = fmtDay(sfDate);
  const maxCombos = sortedResults.length
    ? Math.max(...sortedResults.map(s => s.pairs.length)) : 0;

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle />

      {/* Top bar */}
      <div style={{
        minHeight:38, padding:'0 14px',
        borderBottom:'1px solid var(--line)', background:'var(--bg-2)',
        display:'flex', alignItems:'center', gap:10,
        flexShrink:0, flexWrap:'wrap',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{
            width:8, height:8, borderRadius:999,
            background:'var(--col-done)', boxShadow:'0 0 8px var(--col-done)',
            animation:'pulse 2s ease-in-out infinite',
          }}/>
          <ViewIcon id="slotfinder" size={12} color="var(--ink-2)" />
          <div className="mono uc" style={{ fontSize:11, fontWeight:600 }}>SLOT FINDER</div>
        </div>
        <div style={{ flex:1 }}/>
        <FocusControls />
        {!isMobile && (
          <div className="mono num" style={{ fontSize:11, color:'var(--ink-3)' }}>
            {String(day).padStart(2,'0')} {mo} · {wd}
          </div>
        )}
        <RefreshButton />
        <LastUpdate />
      </div>

      {/* Search strip */}
      <div style={{
        padding:'6px 10px 8px',
        background:'var(--bg-2)',
        borderBottom:'1px solid var(--line)',
        display:'flex', gap:8, alignItems:'flex-end', flexWrap:'wrap',
        flexShrink:0,
      }}>
        <SfSel label="DATE"     value={sfDate}      onChange={setSfDate}              opts={dateOpts} minWidth={130} />
        <SfSel label="DURATION" value={durationMin} onChange={v=>setDurationMin(+v)}  opts={SF_DUR_OPTS} minWidth={74} />
        <SfSel label="BUFFER"   value={gapMin}      onChange={v=>setGapMin(+v)}        opts={SF_GAP_OPTS} minWidth={82} />
        <SfSel label="TYPE"     value={acTypeFilter} onChange={setAcTypeFilter}        opts={typeOpts} />

        {/* Multi-select FI */}
        <SfMultiCheck
          label="FI"
          items={fiItems}
          selected={fiSelected}
          onChange={setFiSelected}
          allLabel="Any available"
          color="var(--col-pending)"
        />

        {/* Multi-select SP */}
        <SfMultiCheck
          label="SP"
          items={spItems}
          selected={spSelected}
          onChange={setSpSelected}
          allLabel="No constraint"
          color="oklch(0.72 0.15 280)"
        />

        {/* Divider */}
        <div style={{ width:1, height:38, background:'var(--line)', alignSelf:'flex-end', marginBottom:1, flexShrink:0 }}/>

        <SfTimeInput label="FROM" value={windowFrom} onChange={setWindowFrom} />
        <SfTimeInput label="TO"   value={windowTo}   onChange={setWindowTo} />

        {/* RWY close toggle */}
        <label style={{ display:'flex', flexDirection:'column', gap:3 }}>
          <span className="mono uc" style={{ fontSize:9, color:'var(--col-cancel)' }}>RWY CLOSE</span>
          <button onClick={() => setRwyEnabled(v => !v)} className="mono uc"
            style={{
              padding:'4px 9px', borderRadius:4, fontSize:10, cursor:'pointer', height:28,
              border:`1px solid ${rwyEnabled ? 'var(--col-cancel)' : 'var(--line)'}`,
              background: rwyEnabled
                ? 'color-mix(in oklch,var(--col-cancel) 14%,transparent)' : 'transparent',
              color: rwyEnabled ? 'var(--col-cancel)' : 'var(--ink-3)',
              fontWeight: rwyEnabled ? 600 : 400,
            }}>{rwyEnabled ? 'ON' : 'OFF'}</button>
        </label>
        {rwyEnabled && (
          <>
            <SfTimeInput label="CLOSED FROM" value={rwyFrom} onChange={setRwyFrom} accent="var(--col-cancel)" />
            <SfTimeInput label="CLOSED TO"   value={rwyTo}   onChange={setRwyTo}   accent="var(--col-cancel)" />
          </>
        )}

        {/* Live result badge */}
        <div style={{ display:'flex', flexDirection:'column', gap:3, marginLeft:'auto' }}>
          <span style={{ fontSize:9 }}>&nbsp;</span>
          <div className="mono uc" style={{
            padding:'4px 12px', borderRadius:4, fontSize:10, fontWeight:600, height:28,
            display:'flex', alignItems:'center',
            border:`1px solid ${sortedResults.length>0 ? 'var(--col-done)' : 'var(--line)'}`,
            background: sortedResults.length>0
              ? 'color-mix(in oklch,var(--col-done) 12%,transparent)' : 'transparent',
            color: sortedResults.length>0 ? 'var(--col-done)' : 'var(--ink-3)',
            transition:'all .15s',
          }}>
            {sortedResults.length>0
              ? `${sortedResults.length} SLOT${sortedResults.length>1?'S':''} · UP TO ${maxCombos} COMBOS`
              : 'NO SLOTS FOUND'}
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:10, padding:'8px' }}>

          <SfTimeline
            busyMap={busyMap}
            allFIs={SF_AP127_FI_NAMES}
            candFIs={candidates.candFIs}
            allTails={allTailsForTimeline}
            candTails={candidates.candTails}
            results={mergedResults}
            windowFrom={windowFrom}
            windowTo={windowTo}
            leavesMap={leavesMap}
            rwyStart={rwyBand.rwyStart}
            rwyEnd={rwyBand.rwyEnd}
          />

          {sortedResults.length === 0 ? (
            <div style={{
              padding:'28px 16px', textAlign:'center',
              color:'var(--ink-3)', fontSize:10,
            }} className="mono uc">
              No available slots — adjust window, duration, buffer, or filters
            </div>
          ) : (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 2px 0' }}>
                <div className="mono uc" style={{ fontSize:11, fontWeight:600, color:'var(--ink)' }}>
                  {sortedResults.length} SLOT{sortedResults.length>1?'S':''}
                </div>
                <div style={{ flex:1 }}/>
                <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>SORT</span>
                {[['earliest','EARLIEST'],['most-combos','MOST COMBOS'],['most-fi','MOST FIs']].map(([v,lbl]) => (
                  <button key={v} onClick={() => setSortBy(v)} className="mono uc"
                    style={{
                      padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
                      border:`1px solid ${sortBy===v ? 'var(--col-pending)' : 'var(--line)'}`,
                      background: sortBy===v
                        ? 'color-mix(in oklch,var(--col-pending) 12%,transparent)' : 'transparent',
                      color: sortBy===v ? 'var(--col-pending)' : 'var(--ink-3)',
                      fontWeight: sortBy===v ? 600 : 400,
                    }}>{lbl}</button>
                ))}
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {sortedResults.map((slot, i) => (
                  <SfSlotCard key={`${slot.t}-${slot.end}-${i}`} slot={slot} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <Drawer />
    </ArtboardShell>
  );
}

window.SlotFinderBoard = SlotFinderBoard;
