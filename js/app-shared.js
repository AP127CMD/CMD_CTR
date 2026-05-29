// Shared tokens, context, helpers and components
const { useState, useMemo, useEffect, useRef, useCallback, createContext, useContext } = React;

// ─── Data ────────────────────────────────────────────────────────────────
const FLIGHTS     = window.FLIGHT_DATA.flights;
const INSTRUCTORS = window.FLIGHT_DATA.instructors;
const RESOURCES   = window.FLIGHT_DATA.resources;
const LEAVES      = window.FLIGHT_DATA.leaves;
const HIGHLIGHT_BATCH = 'AP-127';

// ─── Maintenance & leave helpers ─────────────────────────────────────────
// Set of tail registrations currently in maintenance
const MAINT_TAILS = new Set(RESOURCES.filter(r => r.isMaint).map(r => r.tail));
const isTailMaint = tail => Boolean(tail && MAINT_TAILS.has(tail));

// Returns { name → reason } for all people on leave on the given YYYY-MM-DD date.
// Results are cached so calling this many times per render is free.
const leavesOnDate = (() => {
  const cache = {};
  return date => {
    if (!date) return {};
    if (cache[date]) return cache[date];
    const m = {};
    LEAVES.forEach(l => { if (date >= l.start && date <= l.end) m[l.name] = l.reason || 'On Leave'; });
    return (cache[date] = m);
  };
})();

// Fill in every calendar day between first and last flight date
const ALL_DATES = (() => {
  const src = [...new Set(FLIGHTS.map(f => f.date))].sort();
  if (src.length < 2) return src;
  const result = [];
  let cur = new Date(src[0] + 'T00:00:00Z');
  const last = new Date(src[src.length - 1] + 'T00:00:00Z');
  while (cur <= last) {
    result.push(cur.toISOString().slice(0,10));
    cur = new Date(cur.getTime() + 86400000);
  }
  return result;
})();

// Use local date (not UTC) so Bangkok users see the correct "today" at all hours
const localToday = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

// Default to today if available, else nearest future date
const DEFAULT_DATE = (() => {
  const today = localToday();
  if (ALL_DATES.includes(today)) return today;
  return ALL_DATES.find(d => d >= today) || ALL_DATES[ALL_DATES.length - 1];
})();

const PARTS    = d => d.split('-').map(Number);
const fmtDay   = d => {
  const [y, m, day] = PARTS(d);
  const dt = new Date(Date.UTC(y, m-1, day));
  const wd = ['SUN','MON','TUE','WED','THU','FRI','SAT'][dt.getUTCDay()];
  const mo = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][m-1];
  return { wd, mo, day, y };
};
const minutesOf = hhmm => { if (!hhmm) return null; const [h,m]=hhmm.split(':').map(Number); return h*60+m; };
const fmtHM     = hhmm => hhmm || '—';
const isPast    = d => d < localToday();
const isToday   = d => d === localToday();

// ─── Color system ─────────────────────────────────────────────────────────
const STATUS_COLOR = f => {
  if (f.isSim)      return 'var(--col-sim)';
  if (f.isStandby)  return 'var(--col-stby)';
  if (f.status === 'Completed') return 'var(--col-done)';
  if (f.status === 'Canceled')  return 'var(--col-cancel)';
  return 'var(--col-pending)';
};

const flightAlpha = (f, hlOn) => hlOn && f.batch !== HIGHLIGHT_BATCH ? 0.22 : 1;

const STATUS = {
  Pending:   { fg: 'var(--col-pending)', bg: 'var(--col-pending-bg)',  label: 'PENDING'   },
  Completed: { fg: 'var(--col-done)',    bg: 'var(--col-done-bg)',     label: 'COMPLETED' },
  Canceled:  { fg: 'var(--col-cancel)', bg: 'var(--col-cancel-bg)',   label: 'CANCELED'  },
};

// ─── Theme CSS ────────────────────────────────────────────────────────────
const THEME_CSS = `
  :root, body[data-theme="cockpit"] {
    --bg:       oklch(0.16 0.012 245);
    --bg-2:     oklch(0.20 0.013 245);
    --surface:  oklch(0.22 0.014 245);
    --line:     oklch(0.32 0.018 245);
    --line-soft:oklch(0.27 0.014 245);
    --ink:      oklch(0.96 0.01  245);
    --ink-2:    oklch(0.78 0.012 245);
    --ink-3:    oklch(0.58 0.014 245);
    --col-pending:    oklch(0.83 0.13  75);
    --col-pending-bg: oklch(0.30 0.06  75 / 0.45);
    --col-done:       oklch(0.80 0.13 145);
    --col-done-bg:    oklch(0.28 0.06 145 / 0.45);
    --col-cancel:     oklch(0.68 0.14  25);
    --col-cancel-bg:  oklch(0.26 0.06  25 / 0.45);
    --col-sim:        oklch(0.72 0.12 280);
    --col-stby:       oklch(0.70 0.13 255);
    --highlight:      oklch(0.78 0.20 316);
    --highlight-bg:   oklch(0.28 0.10 316 / 0.55);
    --batch-ap124:    oklch(0.70 0.15 250);
    --batch-ap126:    oklch(0.78 0.14 145);
    --batch-ap127:    oklch(0.78 0.20 316);
    --batch-ap128:    oklch(0.76 0.15  50);
    --batch-ap129:    oklch(0.82 0.12  84);
    --shadow: 0 6px 24px oklch(0 0 0 / 0.4);
  }
  body[data-theme="light"] {
    --bg:       oklch(0.985 0.005 80);
    --bg-2:     oklch(0.965 0.006 80);
    --surface:  oklch(1 0 0);
    --line:     oklch(0.86 0.008 80);
    --line-soft:oklch(0.92 0.006 80);
    --ink:      oklch(0.18 0.01  260);
    --ink-2:    oklch(0.40 0.012 260);
    --ink-3:    oklch(0.56 0.012 260);
    --col-pending:    oklch(0.52 0.13  60);
    --col-pending-bg: oklch(0.94 0.06  75);
    --col-done:       oklch(0.45 0.13 145);
    --col-done-bg:    oklch(0.94 0.06 145);
    --col-cancel:     oklch(0.45 0.14  25);
    --col-cancel-bg:  oklch(0.94 0.05  25);
    --col-sim:        oklch(0.45 0.12 280);
    --col-stby:       oklch(0.45 0.13 255);
    --highlight:      oklch(0.48 0.20 316);
    --highlight-bg:   oklch(0.95 0.06 316);
    --batch-ap124:    oklch(0.45 0.15 250);
    --batch-ap126:    oklch(0.45 0.14 145);
    --batch-ap127:    oklch(0.48 0.20 316);
    --batch-ap128:    oklch(0.50 0.14  50);
    --batch-ap129:    oklch(0.52 0.12  84);
    --shadow: 0 4px 14px oklch(0 0 0 / 0.07);
  }
  body[data-theme="warm"] {
    --bg:       oklch(0.06 0 0);
    --bg-2:     oklch(0.10 0 0);
    --surface:  oklch(0.10 0 0);
    --line:     oklch(0.22 0.01 60);
    --line-soft:oklch(0.16 0.005 60);
    --ink:      oklch(0.96 0.06 75);
    --ink-2:    oklch(0.78 0.10 75);
    --ink-3:    oklch(0.55 0.08 75);
    --col-pending:    oklch(0.85 0.18  75);
    --col-pending-bg: oklch(0.18 0.06  75);
    --col-done:       oklch(0.85 0.18 130);
    --col-done-bg:    oklch(0.18 0.06 130);
    --col-cancel:     oklch(0.70 0.18  25);
    --col-cancel-bg:  oklch(0.20 0.06  25);
    --col-sim:        oklch(0.75 0.14 280);
    --col-stby:       oklch(0.70 0.16 255);
    --highlight:      oklch(0.82 0.22 316);
    --highlight-bg:   oklch(0.22 0.08 316);
    --batch-ap124:    oklch(0.72 0.16 250);
    --batch-ap126:    oklch(0.82 0.16 140);
    --batch-ap127:    oklch(0.82 0.22 316);
    --batch-ap128:    oklch(0.80 0.16  50);
    --batch-ap129:    oklch(0.84 0.14  84);
    --shadow: 0 0 0 1px oklch(0.22 0.01 60), 0 8px 30px oklch(0 0 0 / 0.6);
  }
  body { background: var(--bg); color: var(--ink); }
  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-feature-settings: 'tnum' 1, 'zero' 1; }
  .num  { font-variant-numeric: tabular-nums; }
  .uc   { text-transform: uppercase; letter-spacing: 0.06em; }
`;

// ─── App Context ──────────────────────────────────────────────────────────
const AppCtx = createContext(null);
const useApp  = () => useContext(AppCtx);

function AppProvider({ children, tweaks, setTweak, isMobile=false, setView=null }) {
  const [date, setDate]               = useState(DEFAULT_DATE);
  const [filters, setFilters]         = useState({ batches:null, instructors:null, tails:null, statuses:null, search:'' });
  const [drawer, setDrawer]           = useState(null);
  const [highlightAP127, setHighlightAP127] = useState(true);
  const [hideOthers, setHideOthers]   = useState(false);

  useEffect(() => { document.body.dataset.theme = tweaks.theme || 'cockpit'; }, [tweaks.theme]);

  const dayFlights = useMemo(() => {
    return FLIGHTS.filter(x => {
      if (x.date !== date) return false;
      if (!tweaks.showSim     && x.isSim)     return false;
      if (!tweaks.showStandby && x.isStandby) return false;
      if (filters.batches     && !filters.batches.includes(x.batch))         return false;
      if (filters.instructors && !filters.instructors.includes(x.instructor)) return false;
      if (filters.tails       && !filters.tails.includes(x.tail))             return false;
      if (filters.statuses) {
        const matchStatus = filters.statuses.includes(x.status);
        const matchStby   = filters.statuses.includes('Standby') && x.isStandby;
        if (!matchStatus && !matchStby) return false;
      }
      if (hideOthers && highlightAP127 && x.batch !== HIGHLIGHT_BATCH)         return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = [x.student, x.instructor, x.batch, x.lesson, x.tail, x.type].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [date, filters, tweaks.showSim, tweaks.showStandby, hideOthers, highlightAP127]);

  const value = {
    date, setDate, filters, setFilters,
    drawer, setDrawer,
    highlightAP127, setHighlightAP127,
    hideOthers, setHideOthers,
    tweaks, setTweak: setTweak || (() => {}),
    dayFlights,
    flightById: id => FLIGHTS.find(f => f.id === id),
    isMobile,
    setView: setView || (() => {}),
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

// ─── Small atoms ─────────────────────────────────────────────────────────
function ThemeStyle() { return <style dangerouslySetInnerHTML={{ __html: THEME_CSS }}/>; }

function ArtboardShell({ children, style }) {
  return (
    <div style={{ position:'relative', width:'100%', height:'100%', background:'var(--bg)', color:'var(--ink)', fontFamily:'"Inter",system-ui,sans-serif', overflow:'hidden', ...style }}>
      {children}
    </div>
  );
}

function FlightDot({ f }) {
  const c = STATUS_COLOR(f);
  return (
    <span title={f.status} style={{
      display:'inline-block', width:7, height:7, borderRadius:2,
      background: c, boxShadow:`0 0 6px color-mix(in oklch,${c} 55%,transparent)`,
      flexShrink: 0,
    }}/>
  );
}

function ConditionTag({ cond }) {
  if (!cond) return null;
  return (
    <span className="mono uc" style={{
      fontSize:9, color:'var(--ink-3)', padding:'1px 5px',
      borderRadius:3, border:'1px solid var(--line-soft)', whiteSpace:'nowrap',
    }}>{cond}</span>
  );
}

function StatusPill({ status, size='sm' }) {
  const s = STATUS[status] || STATUS.Pending;
  const pad = size==='lg' ? '4px 10px' : '2px 7px';
  const fs  = size==='lg' ? 11 : 10;
  return (
    <span className="mono uc" style={{
      display:'inline-flex', alignItems:'center', gap:5,
      padding:pad, borderRadius:999,
      background:s.bg, color:s.fg, fontSize:fs, fontWeight:600,
      border:`1px solid color-mix(in oklch,${s.fg} 30%,transparent)`,
    }}>
      <span style={{ width:6,height:6,borderRadius:999,background:s.fg,boxShadow:`0 0 6px ${s.fg}`,flexShrink:0 }}/>
      {s.label}
    </span>
  );
}

function Tag({ children, color='var(--ink-2)', filled=false, mono=true }) {
  return (
    <span className={mono?'mono uc':'uc'} style={{
      display:'inline-flex', alignItems:'center',
      padding:'2px 7px', borderRadius:4, fontSize:10,
      color: filled?'var(--bg)':color,
      background: filled?color:'transparent',
      border: filled?'none':`1px solid color-mix(in oklch,${color} 35%,transparent)`,
      whiteSpace:'nowrap',
    }}>{children}</span>
  );
}

function StandbyTag({ size='sm' }) {
  const fs  = size==='lg' ? 11 : 10;
  const pad = size==='lg' ? '3px 9px' : '2px 6px';
  return (
    <span className="mono uc" style={{
      display:'inline-flex', alignItems:'center', gap:5,
      padding:pad, borderRadius:4, fontSize:fs, fontWeight:600,
      color:'var(--col-stby)',
      background:'color-mix(in oklch,var(--col-stby) 10%,transparent)',
      border:'1px dashed color-mix(in oklch,var(--col-stby) 55%,transparent)',
      whiteSpace:'nowrap',
    }}>◌ STBY</span>
  );
}

// Aircraft in maintenance — red "GND" chip
function GndBadge() {
  return (
    <span className="mono uc" style={{
      display:'inline-flex', alignItems:'center',
      fontSize:8, padding:'1px 4px', borderRadius:2, lineHeight:1.3,
      background:'color-mix(in oklch,var(--col-cancel) 14%,transparent)',
      border:'1px solid var(--col-cancel)', color:'var(--col-cancel)',
      fontWeight:700, flexShrink:0,
    }}>GND</span>
  );
}

// Person on leave — blue "LEAVE" chip
function LeaveBadge({ reason }) {
  return (
    <span className="mono uc" title={reason||'On Leave'} style={{
      display:'inline-flex', alignItems:'center',
      fontSize:8, padding:'1px 4px', borderRadius:2, lineHeight:1.3,
      background:'color-mix(in oklch,var(--col-stby) 14%,transparent)',
      border:'1px solid var(--col-stby)', color:'var(--col-stby)',
      fontWeight:600, flexShrink:0,
    }}>LEAVE</span>
  );
}

function HighlightBar({ on }) {
  if (!on) return null;
  return <span style={{
    position:'absolute', left:0, top:6, bottom:6, width:3,
    background:'var(--highlight)', boxShadow:'0 0 10px var(--highlight)', borderRadius:2,
  }}/>;
}

// ─── Calendar date picker ────────────────────────────────────────────────
const CAL_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DATE_SET   = new Set(ALL_DATES);

function DateCalendarPopup({ onClose }) {
  const { date, setDate } = useApp();
  const today = localToday();
  const [vy, setVy] = useState(() => Number(date.slice(0,4)));
  const [vm, setVm] = useState(() => Number(date.slice(5,7)));

  // Build grid: Mon=0 … Sun=6 offset
  const grid = useMemo(() => {
    const first = new Date(Date.UTC(vy, vm-1, 1));
    const offset = (first.getUTCDay() + 6) % 7; // Mon=0
    const days   = new Date(Date.UTC(vy, vm, 0)).getUTCDate();
    const cells  = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) cells.push(`${vy}-${String(vm).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [vy, vm]);

  const [fy, fm] = ALL_DATES[0].split('-').map(Number);
  const [ly, lm] = ALL_DATES[ALL_DATES.length-1].split('-').map(Number);
  const atFirst  = vy < fy || (vy === fy && vm <= fm);
  const atLast   = vy > ly || (vy === ly && vm >= lm);

  const prevM = () => { if (vm===1){setVy(y=>y-1);setVm(12);}else setVm(m=>m-1); };
  const nextM = () => { if (vm===12){setVy(y=>y+1);setVm(1);}else setVm(m=>m+1); };

  const BtnStyle = dis => ({
    padding:'3px 8px', fontSize:12, background:'transparent', cursor:dis?'default':'pointer',
    border:'1px solid var(--line)', borderRadius:4, color:dis?'var(--ink-3)':'var(--ink-2)',
    opacity:dis?0.3:1,
  });

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:90 }}/>
      <div onClick={e=>e.stopPropagation()} style={{
        position:'absolute', zIndex:91, top:'calc(100% + 4px)', left:0,
        background:'var(--surface)', border:'1px solid var(--line)',
        borderRadius:8, padding:'10px 10px 8px',
        boxShadow:'0 8px 32px oklch(0 0 0 / 0.45)', minWidth:224, userSelect:'none',
      }}>
        {/* Month nav */}
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
          <button onClick={prevM} disabled={atFirst} style={BtnStyle(atFirst)}>‹</button>
          <div style={{ flex:1, textAlign:'center' }} className="mono uc">
            <span style={{ fontSize:11, fontWeight:600, color:'var(--ink)' }}>{CAL_MONTHS[vm-1]}</span>
            <span style={{ fontSize:10, color:'var(--ink-3)', marginLeft:5 }}>{vy}</span>
          </div>
          <button onClick={nextM} disabled={atLast} style={BtnStyle(atLast)}>›</button>
        </div>
        {/* Day-of-week header */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, marginBottom:4 }}>
          {['M','T','W','T','F','S','S'].map((d,i)=>(
            <div key={i} className="mono" style={{ textAlign:'center', fontSize:8, color:'var(--ink-3)', padding:'2px 0', fontWeight:600 }}>{d}</div>
          ))}
        </div>
        {/* Date cells */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2 }}>
          {grid.map((d,i)=>{
            if (!d) return <div key={i}/>;
            const inRange = DATE_SET.has(d);
            const isSel   = d === date;
            const isTod   = d === today;
            const dayNum  = Number(d.slice(8));
            return (
              <button key={i} disabled={!inRange}
                onClick={()=>{ if(inRange){ setDate(d); onClose(); } }}
                className="mono num"
                style={{
                  padding:'5px 2px', fontSize:11, borderRadius:4, textAlign:'center',
                  cursor: inRange?'pointer':'default',
                  border: isSel?'1px solid var(--col-pending)':isTod?'1px solid color-mix(in oklch,var(--col-pending) 50%,transparent)':'1px solid transparent',
                  background: isSel?'color-mix(in oklch,var(--col-pending) 18%,var(--bg-2))':'transparent',
                  color: !inRange?'var(--line)': isSel?'var(--ink)':'var(--ink-2)',
                  fontWeight: isSel?700:400,
                }}>{dayNum}</button>
            );
          })}
        </div>
        <div className="mono uc" style={{ fontSize:7, color:'var(--ink-3)', textAlign:'center', marginTop:6, borderTop:'1px solid var(--line-soft)', paddingTop:5 }}>
          ONLY SCHEDULED DATES SELECTABLE
        </div>
      </div>
    </>
  );
}

function DateCalendarTrigger() {
  const { date } = useApp();
  const [open, setOpen] = useState(false);
  const { wd, day, mo } = fmtDay(date);
  return (
    <div style={{ position:'relative', display:'inline-block' }}>
      <button onClick={()=>setOpen(v=>!v)} className="mono"
        style={{
          padding:'4px 10px',
          border:`1px solid ${open?'var(--col-pending)':'var(--line)'}`,
          background: open?'color-mix(in oklch,var(--col-pending) 12%,var(--surface))':'var(--surface)',
          color:'var(--ink)', borderRadius:6, cursor:'pointer',
          display:'flex', flexDirection:'row', alignItems:'center', gap:8,
        }}>
        <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>{wd}</span>
        <span className="num" style={{ fontSize:16, fontWeight:600 }}>{String(day).padStart(2,'0')}</span>
        <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>{mo}</span>
        <span style={{ fontSize:9, color:'var(--ink-3)', marginLeft:2 }}>▾</span>
      </button>
      {open && <DateCalendarPopup onClose={()=>setOpen(false)}/>}
    </div>
  );
}

// ─── Refresh Button ───────────────────────────────────────────────────────
function RefreshButton() {
  return (
    <button title="Force reload page from server (bypasses browser cache)"
      onClick={()=>window.location.reload(true)}
      className="mono uc"
      style={{
        padding:'3px 8px', fontSize:9, borderRadius:4, cursor:'pointer',
        border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)',
        display:'flex', alignItems:'center', gap:4, transition:'all .1s',
        flexShrink:0,
      }}>⟳ SYNC</button>
  );
}

// ─── Filter Bar ───────────────────────────────────────────────────────────
function FilterBar() {
  const { filters, setFilters } = useApp();
  const [open, setOpen] = useState(false);

  const allBatches     = useMemo(()=>[...new Set(FLIGHTS.map(f=>f.batch))].filter(Boolean).sort(),[]);
  const allInstructors = useMemo(()=>[...new Set(FLIGHTS.map(f=>f.instructor))].filter(Boolean).sort(),[]);
  const allTails       = useMemo(()=>[...new Set(FLIGHTS.map(f=>f.tail))].filter(Boolean).sort(),[]);
  const allStatuses    = ['Canceled','Completed','Pending','Standby'];

  // Aircraft grouped by type (from RESOURCES), priority DA40TDI → DA40CS → rest
  const tailsByType = useMemo(()=>{
    const pri = t => t==='DA40TDI'?0:t==='DA40CS'?1:2;
    const groups = {};
    RESOURCES.forEach(r=>{
      if (!r.tail || !r.acType || /SIM|Classroom/i.test(r.acType)) return;
      if (!allTails.includes(r.tail)) return;
      if (!groups[r.acType]) groups[r.acType]=[];
      if (!groups[r.acType].includes(r.tail)) groups[r.acType].push(r.tail);
    });
    // Any tails from flights not listed in RESOURCES go into OTHER
    allTails.forEach(t=>{
      if (!RESOURCES.some(r=>r.tail===t)){
        if (!groups['OTHER']) groups['OTHER']=[];
        if (!groups['OTHER'].includes(t)) groups['OTHER'].push(t);
      }
    });
    Object.values(groups).forEach(g=>g.sort());
    return Object.entries(groups).sort((a,b)=>pri(a[0])-pri(b[0]));
  },[allTails]);

  const getAll = key => key==='batches'?allBatches:key==='instructors'?allInstructors:key==='tails'?allTails:allStatuses;

  const isChecked = (key, val) => {
    const cur = filters[key];
    return cur===null||cur.includes(val);
  };

  const toggle = (key, val) => {
    setFilters(f=>{
      const all = getAll(key);
      const cur = f[key]===null ? all : f[key];
      const next = cur.includes(val) ? cur.filter(v=>v!==val) : [...cur, val];
      const isAll = next.length===all.length && all.every(v=>next.includes(v));
      return {...f, [key]: isAll||!next.length ? null : next};
    });
  };

  const onlyFilter = (key, val) => setFilters(f=>({...f,[key]:[val]}));
  const clearFilter = key => setFilters(f=>({...f,[key]:null}));

  const activeCount = [filters.batches,filters.instructors,filters.tails,filters.statuses].filter(Boolean).length;

  // Small checkbox row for a single item
  const ItemRow = ({filterKey, val, label}) => {
    const checked = isChecked(filterKey, val);
    return (
      <div style={{ display:'flex', alignItems:'center', gap:3 }}>
        <button onClick={()=>toggle(filterKey,val)}
          style={{ display:'flex', alignItems:'center', gap:5, flex:1, background:'transparent', border:'none', cursor:'pointer', padding:'2px 0', textAlign:'left' }}>
          <span style={{
            width:11, height:11, borderRadius:2, flexShrink:0,
            border:`1px solid ${checked?'var(--col-pending)':'var(--line)'}`,
            background: checked?'var(--col-pending)':'transparent',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            {checked && <span style={{ fontSize:8, color:'var(--bg)', fontWeight:700, lineHeight:1 }}>✓</span>}
          </span>
          <span className="mono" style={{ fontSize:10, color:'var(--ink-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>{label||val}</span>
        </button>
        <button onClick={()=>onlyFilter(filterKey,val)} className="mono uc"
          style={{ fontSize:7, padding:'1px 4px', borderRadius:2, cursor:'pointer',
            border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)',
            flexShrink:0, transition:'all .1s',
          }}>ONLY</button>
      </div>
    );
  };

  // Section header with ALL reset
  const SectionHead = ({label, filterKey}) => (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
      <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)', flex:1 }}>{label}</span>
      {filters[filterKey] && (
        <button onClick={()=>clearFilter(filterKey)} className="mono uc"
          style={{ fontSize:7, padding:'1px 5px', borderRadius:2, cursor:'pointer',
            border:'1px solid var(--col-pending)', color:'var(--col-pending)', background:'transparent',
          }}>ALL</button>
      )}
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      {/* Top row: search + filter toggle */}
      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
        <div style={{ position:'relative', flex:'1 1 160px', minWidth:120 }}>
          <input value={filters.search} onChange={e=>setFilters(f=>({...f,search:e.target.value}))}
            placeholder="search student / lesson / tail…"
            style={{ width:'100%', background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)',
              borderRadius:4, padding:'4px 10px 4px 24px', fontSize:10, outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}/>
          <span style={{ position:'absolute',left:7,top:'50%',transform:'translateY(-50%)',color:'var(--ink-3)',fontSize:11,pointerEvents:'none' }}>⌕</span>
          {filters.search && (
            <button onClick={()=>setFilters(f=>({...f,search:''}))}
              style={{ position:'absolute',right:6,top:'50%',transform:'translateY(-50%)',background:'transparent',border:'none',cursor:'pointer',color:'var(--ink-3)',fontSize:11,padding:0 }}>✕</button>
          )}
        </div>
        <button onClick={()=>setOpen(v=>!v)} className="mono uc"
          style={{
            padding:'4px 8px', fontSize:9, borderRadius:4, cursor:'pointer', flexShrink:0,
            border:`1px solid ${open||activeCount>0?'var(--col-pending)':'var(--line)'}`,
            background: open||activeCount>0?'color-mix(in oklch,var(--col-pending) 10%,transparent)':'transparent',
            color: open||activeCount>0?'var(--col-pending)':'var(--ink-3)',
            fontWeight: activeCount>0?600:400,
          }}>
          FILTERS{activeCount>0?` (${activeCount})`:''} {open?'▲':'▾'}
        </button>
        {activeCount>0 && (
          <button onClick={()=>setFilters(f=>({...f,batches:null,instructors:null,tails:null,statuses:null}))}
            className="mono uc" style={{ fontSize:8, padding:'3px 7px', borderRadius:3, cursor:'pointer',
              border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)', flexShrink:0 }}>
            CLEAR
          </button>
        )}
      </div>

      {/* Expanded filter panel */}
      {open && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:12, padding:'8px 10px', background:'var(--surface)', border:'1px solid var(--line)', borderRadius:6 }}>
          {/* BATCH */}
          <div>
            <SectionHead label="BATCH" filterKey="batches"/>
            <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
              {allBatches.map(v=><ItemRow key={v} filterKey="batches" val={v}/>)}
            </div>
          </div>
          {/* STATUS */}
          <div>
            <SectionHead label="STATUS" filterKey="statuses"/>
            <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
              {allStatuses.map(v=><ItemRow key={v} filterKey="statuses" val={v}/>)}
            </div>
          </div>
          {/* AIRCRAFT grouped by type */}
          <div>
            <SectionHead label="AIRCRAFT" filterKey="tails"/>
            <div style={{ display:'flex', flexDirection:'column', gap:2, maxHeight:180, overflowY:'auto' }}>
              {tailsByType.map(([type, tails])=>(
                <div key={type}>
                  <div className="mono uc" style={{ fontSize:7, color:'var(--ink-3)', margin:'4px 0 2px', letterSpacing:'0.05em' }}>{type}</div>
                  {tails.map(v=><ItemRow key={v} filterKey="tails" val={v}/>)}
                </div>
              ))}
            </div>
          </div>
          {/* INSTRUCTOR */}
          <div>
            <SectionHead label="INSTRUCTOR" filterKey="instructors"/>
            <div style={{ display:'flex', flexDirection:'column', gap:2, maxHeight:180, overflowY:'auto' }}>
              {allInstructors.map(v=><ItemRow key={v} filterKey="instructors" val={v}/>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline Settings bar ──────────────────────────────────────────────────
function InlineSettings({ gantt=false }) {
  const { tweaks, setTweak, highlightAP127, setHighlightAP127, hideOthers, setHideOthers } = useApp();
  const Chip = ({ on, onClick, children, color='var(--ink-2)' }) => (
    <button onClick={onClick} className="mono uc" style={{
      padding:'4px 10px', fontSize:10, borderRadius:4, cursor:'pointer',
      border:`1px solid ${on?color:'var(--line)'}`,
      background: on?`color-mix(in oklch,${color} 14%,var(--surface))`:'transparent',
      color: on?color:'var(--ink-3)', fontWeight: on?600:400, transition:'all .1s',
    }}>{children}</button>
  );
  return (
    <div style={{
      padding:'4px 24px', borderBottom:'1px solid var(--line-soft)',
      background:'var(--bg-2)', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap',
      flexShrink:0,
    }}>
      <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>THEME</span>
      {['cockpit','light','warm'].map(th=>(
        <Chip key={th} on={tweaks.theme===th} onClick={()=>setTweak('theme',th)} color="var(--ink-2)">{th}</Chip>
      ))}
      <div style={{ width:1,height:16,background:'var(--line)',margin:'0 4px' }}/>
      <Chip on={highlightAP127} onClick={()=>setHighlightAP127(v=>!v)} color="var(--highlight)">◆ AP-127 FOCUS</Chip>
      <span style={{opacity:highlightAP127?1:0.35,transition:'opacity .15s'}}>
        <Chip on={hideOthers} onClick={()=>setHideOthers(v=>!v)} color="var(--highlight)">HIDE OTHERS</Chip>
      </span>
      <Chip on={tweaks.showSim}     onClick={()=>setTweak('showSim',!tweaks.showSim)}         color="var(--col-sim)">SIM</Chip>
      <Chip on={tweaks.showStandby} onClick={()=>setTweak('showStandby',!tweaks.showStandby)} color="var(--col-stby)">STBY</Chip>
      {gantt && <>
        <div style={{ width:1,height:16,background:'var(--line)',margin:'0 4px' }}/>
        <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>GROUP</span>
        {['instructor','tail','batch'].map(g=>(
          <Chip key={g} on={tweaks.groupBy===g} onClick={()=>setTweak('groupBy',g)} color="var(--ink-2)">{g}</Chip>
        ))}
      </>}
    </div>
  );
}

// ─── (sidebar resize is handled directly in App in index.html) ───────────

// ─── Drawer (view-only) ───────────────────────────────────────────────────
function Drawer() {
  const { drawer, setDrawer, flightById } = useApp();
  if (!drawer) return null;
  const f = flightById(drawer);
  if (!f) return null;
  const isHL  = f.batch === HIGHLIGHT_BATCH;
  const color = STATUS_COLOR(f);
  const Row   = ({ k, v }) => (
    <div style={{ display:'grid', gridTemplateColumns:'110px 1fr', gap:12, padding:'8px 0', borderBottom:'1px solid var(--line-soft)' }}>
      <div className="mono uc" style={{ fontSize:10, color:'var(--ink-3)' }}>{k}</div>
      <div style={{ fontSize:13, color:'var(--ink)' }}>{v ?? <span style={{color:'var(--ink-3)'}}>—</span>}</div>
    </div>
  );
  return (
    <div onClick={()=>setDrawer(null)} style={{
      position:'absolute', inset:0, background:'oklch(0 0 0 / 0.45)',
      display:'flex', justifyContent:'flex-end', zIndex:50, backdropFilter:'blur(2px)',
    }}>
      <div onClick={e=>e.stopPropagation()} style={{
        width:380, height:'100%', background:'var(--surface)',
        borderLeft:'1px solid var(--line)', boxShadow:'-12px 0 30px oklch(0 0 0 / 0.35)',
        display:'flex', flexDirection:'column',
      }}>
        <div style={{ height:3, background:color, opacity:.9 }}/>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--line)', display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div className="mono uc" style={{ fontSize:10, color:'var(--ink-3)', marginBottom:4 }}>FLIGHT · {f.id}</div>
            <div style={{ fontSize:22, fontWeight:600, lineHeight:1.1 }}>{f.student||'—'}</div>
            <div className="mono" style={{ fontSize:11, color:'var(--ink-2)', marginTop:4 }}>{f.batch} · {f.lesson}</div>
          </div>
          <button onClick={()=>setDrawer(null)} style={{ background:'transparent',color:'var(--ink-2)',border:'none',cursor:'pointer',fontSize:18 }}>✕</button>
        </div>
        <div style={{ padding:'8px 20px', flex:1, overflowY:'auto' }}>
          <div style={{ display:'flex', gap:8, padding:'12px 0', flexWrap:'wrap' }}>
            <StatusPill status={f.status} size="lg"/>
            {f.isStandby && <StandbyTag size="lg"/>}
            {f.isSim     && <Tag color="var(--col-sim)">SIM</Tag>}
            {isHL        && <Tag color="var(--highlight)" filled>AP-127</Tag>}
          </div>
          <Row k="TIME"       v={<span className="mono">{f.start} — {f.end} · {f.duration}</span>}/>
          <Row k="DURATION"   v={<span className="mono">{Math.floor(f.durMin/60)}h {f.durMin%60}m</span>}/>
          <Row k="STUDENT"    v={f.student}/>
          <Row k="INSTRUCTOR" v={f.instructor}/>
          <Row k="BATCH"      v={<span className="mono">{f.batch}</span>}/>
          <Row k="LESSON"     v={<span className="mono">{f.lesson}</span>}/>
          <Row k="CONDITION"  v={f.cond}/>
          {f.isStandby && <Row k="STANDBY" v={<span style={{color:'var(--col-stby)'}}>Waiting for slot to open</span>}/>}
          <Row k="A/C TYPE"   v={<span className="mono">{f.type}</span>}/>
          <Row k="TAIL"       v={<span className="mono" style={{ display:'inline-block',padding:'2px 8px',borderRadius:3,background:'var(--bg-2)',border:'1px solid var(--line)' }}>{f.tail||'TBD'}</span>}/>
          {f.status === 'Completed' && (f.tkoff || f.ldgTime || f.airborne) && (
            <Row k="ACTUAL TIMES" v={
              <span className="mono" style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
                {f.tkoff   && <span style={{color:'var(--ink-2)'}}>T/O <strong>{f.tkoff}</strong></span>}
                {f.ldgTime && <span style={{color:'var(--ink-2)'}}>LDG <strong>{f.ldgTime}</strong></span>}
                {f.airborne && <span style={{color:'var(--ink-3)'}}>AIR <strong>{f.airborne}</strong></span>}
              </span>
            }/>
          )}
          {f.status === 'Completed' && (f.to != null || f.ldg != null || f.inst != null) && (
            <Row k="T/O · LDG · INST" v={
              <span className="mono" style={{ display:'flex', gap:16 }}>
                <span><span style={{color:'var(--ink-3)',fontSize:10}}>T/O</span> <strong style={{fontSize:15}}>{f.to ?? '—'}</strong></span>
                <span><span style={{color:'var(--ink-3)',fontSize:10}}>LDG</span> <strong style={{fontSize:15}}>{f.ldg ?? '—'}</strong></span>
                <span><span style={{color:'var(--ink-3)',fontSize:10}}>INST</span> <strong style={{fontSize:15}}>{f.inst ?? '—'}</strong></span>
              </span>
            }/>
          )}
        </div>
        <div className="mono uc" style={{ padding:'10px 20px', fontSize:9, color:'var(--ink-3)', borderTop:'1px solid var(--line-soft)', textAlign:'center' }}>
          VIEW ONLY · CLICK OUTSIDE TO CLOSE
        </div>
      </div>
    </div>
  );
}

// ─── View icons ───────────────────────────────────────────────────────────
function ViewIcon({ id, size=13, color='currentColor' }) {
  if (id === 'board') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill={color}>
      <rect x="1" y="1" width="5" height="5" rx="1" opacity=".85"/>
      <rect x="8" y="1" width="5" height="5" rx="1" opacity=".85"/>
      <rect x="1" y="8" width="5" height="5" rx="1" opacity=".85"/>
      <rect x="8" y="8" width="5" height="5" rx="1" opacity=".85"/>
    </svg>
  );
  if (id === 'gantt') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill={color}>
      <rect x="2" y="1.5" width="8" height="2.5" rx="1"/>
      <rect x="5" y="5.5" width="7" height="2.5" rx="1" opacity=".75"/>
      <rect x="1" y="9.5" width="10" height="2.5" rx="1" opacity=".55"/>
      <rect x="1" y="1" width="1.5" height="12" rx=".5" opacity=".3"/>
    </svg>
  );
  if (id === 'weekly') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.3">
      <rect x="1.5" y="3" width="11" height="9.5" rx="1"/>
      <line x1="1.5" y1="6" x2="12.5" y2="6"/>
      <line x1="5.2" y1="3" x2="5.2" y2="12.5"/>
      <line x1="8.8" y1="3" x2="8.8" y2="12.5"/>
      <line x1="4" y1="1" x2="4" y2="3.5"/>
      <line x1="10" y1="1" x2="10" y2="3.5"/>
    </svg>
  );
  if (id === 'summary') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill={color}>
      <path d="M7 7L7 1.2A5.8 5.8 0 0 1 12.8 7Z" opacity=".9"/>
      <path d="M7 7L1.2 7A5.8 5.8 0 0 1 7 1.2Z" opacity=".55"/>
      <path d="M7 7L12.8 7A5.8 5.8 0 0 1 3.2 11.4Z" opacity=".35"/>
    </svg>
  );
  if (id === 'daily') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.2">
      <circle cx="7" cy="7" r="3" fill={color} stroke="none"/>
      <line x1="7" y1="0.5" x2="7" y2="2.5"/>
      <line x1="7" y1="11.5" x2="7" y2="13.5"/>
      <line x1="0.5" y1="7" x2="2.5" y2="7"/>
      <line x1="11.5" y1="7" x2="13.5" y2="7"/>
      <line x1="2.3" y1="2.3" x2="3.7" y2="3.7"/>
      <line x1="10.3" y1="10.3" x2="11.7" y2="11.7"/>
      <line x1="11.7" y1="2.3" x2="10.3" y2="3.7"/>
      <line x1="3.7" y1="10.3" x2="2.3" y2="11.7"/>
    </svg>
  );
  if (id === 'slotfinder') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.2">
      {/* Calendar */}
      <rect x="1.5" y="3" width="9" height="8.5" rx="1"/>
      <line x1="1.5" y1="5.8" x2="10.5" y2="5.8"/>
      <line x1="4"   y1="1.5" x2="4"   y2="3.5"/>
      <line x1="8"   y1="1.5" x2="8"   y2="3.5"/>
      {/* Magnifying glass (bottom-right, overlapping) */}
      <circle cx="10.5" cy="10.5" r="2.6"/>
      <line x1="12.4" y1="12.4" x2="13.5" y2="13.5" strokeWidth="1.5" strokeLinecap="round"/>
      {/* Checkmark inside lens */}
      <path d="M9.4 10.5 L10.2 11.4 L11.7 9.6" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1"/>
    </svg>
  );
  if (id === 'autoslotfinder') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.2">
      {/* Lightning bolt (auto/instant) */}
      <path d="M5.4 1.2 L2.6 7 L5.4 7 L4.2 12.8 L9.4 6 L6.4 6 L7.6 1.2 Z"
            fill={color} stroke="none" opacity=".85"/>
      {/* Magnifying glass — smaller, top-right */}
      <circle cx="10.6" cy="3.6" r="2"/>
      <line x1="12" y1="5.1" x2="13.2" y2="6.3" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
  if (id === 'calendar') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.2">
      <rect x="1.5" y="2.5" width="11" height="10" rx="1"/>
      <line x1="1.5" y1="5.5" x2="12.5" y2="5.5"/>
      <line x1="4.5" y1="1" x2="4.5" y2="3"/>
      <line x1="9.5" y1="1" x2="9.5" y2="3"/>
      <rect x="3.5" y="7" width="2" height="2" rx=".3" fill={color} stroke="none"/>
      <rect x="6.5" y="7" width="2" height="2" rx=".3" fill={color} stroke="none" opacity=".6"/>
      <rect x="3.5" y="9.5" width="2" height="1.5" rx=".3" fill={color} stroke="none" opacity=".4"/>
      <rect x="6.5" y="9.5" width="2" height="1.5" rx=".3" fill={color} stroke="none" opacity=".6"/>
      <rect x="9.5" y="7" width="2" height="1.5" rx=".3" fill={color} stroke="none" opacity=".4"/>
    </svg>
  );
  if (id === 'roster') return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill={color}>
      <rect x="1"   y="4.5" width="3.5" height="2"   rx=".4" opacity=".9"/>
      <rect x="5.5" y="4.5" width="3.5" height="2"   rx=".4" opacity=".5"/>
      <rect x="10"  y="4.5" width="3.5" height="2"   rx=".4" opacity=".7"/>
      <rect x="1"   y="7.5" width="3.5" height="2"   rx=".4" opacity=".5"/>
      <rect x="5.5" y="7.5" width="3.5" height="2"   rx=".4" opacity=".9"/>
      <rect x="10"  y="7.5" width="3.5" height="2"   rx=".4" opacity=".4"/>
      <rect x="1"   y="10.5" width="3.5" height="2"  rx=".4" opacity=".3"/>
      <rect x="5.5" y="10.5" width="3.5" height="2"  rx=".4" opacity=".6"/>
      <rect x="10"  y="10.5" width="3.5" height="2"  rx=".4" opacity=".8"/>
      <line x1="1" y1="3.5" x2="13" y2="3.5" stroke={color} strokeWidth="1" opacity=".5"/>
    </svg>
  );
  return null;
}

// ─── Last-update indicator (shown in every view header) ──────────────────
// Self-hides on mobile unless `showOnMobile` is set (MobileTopBar uses that).
function LastUpdate({ showOnMobile = false }) {
  const app = useApp();
  const mob = !!(app && app.isMobile);
  if (mob && !showOnMobile) return null;
  const iso = window.FLIGHT_DATA && window.FLIGHT_DATA.fetchedAt;
  const tz  = (window.FLIGHT_DATA && window.FLIGHT_DATA.tz) || 'Asia/Bangkok';
  let label = '—';
  if (iso) {
    try {
      label = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso)).replace(',', '').toUpperCase();
    } catch { label = String(iso); }
  }
  return (
    <div className="mono uc" title={`Flight data last fetched ${label} · ${tz}`} style={{
      display: 'flex', alignItems: 'center', gap: 5, fontSize: 9,
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--col-done)', boxShadow: '0 0 5px var(--col-done)', flexShrink: 0 }}/>
      {!mob && <span style={{ color: 'var(--ink-3)' }}>UPDATED</span>}
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
    </div>
  );
}

// ─── Focus controls (AP-127 highlight + hide-others, shown in view headers) ──
function FocusControls() {
  const { highlightAP127, setHighlightAP127, hideOthers, setHideOthers } = useApp();
  const Chip = ({ on, onClick, children, color }) => (
    <button onClick={onClick} className="mono uc" style={{
      padding:'3px 8px', fontSize:9, borderRadius:4, cursor:'pointer',
      border:`1px solid ${on ? color : 'var(--line)'}`,
      background: on ? `color-mix(in oklch,${color} 14%,var(--surface))` : 'transparent',
      color: on ? color : 'var(--ink-3)', fontWeight: on ? 600 : 400, transition:'all .1s',
      whiteSpace:'nowrap',
    }}>{children}</button>
  );
  return (
    <div style={{ display:'flex', gap:4, alignItems:'center', flexShrink:0 }}>
      <Chip on={highlightAP127} onClick={()=>setHighlightAP127(v=>!v)} color="var(--highlight)"
        title="Highlight AP-127 batch flights. Toggle off to show all batches equally.">◆ AP-127</Chip>
      <span style={{ opacity: highlightAP127 ? 1 : 0.35, transition:'opacity .15s' }}
        title={highlightAP127 ? '' : 'Enable AP-127 focus first to use HIDE'}>
        <Chip on={hideOthers} onClick={()=>setHideOthers(v=>!v)} color="var(--highlight)"
          title="Show only AP-127 flights in the current view.">ONLY</Chip>
      </span>
    </div>
  );
}

Object.assign(window, {
  AppCtx, AppProvider, useApp, ThemeStyle, ArtboardShell,
  FLIGHTS, INSTRUCTORS, RESOURCES, LEAVES, ALL_DATES, DEFAULT_DATE, HIGHLIGHT_BATCH,
  MAINT_TAILS, isTailMaint, leavesOnDate,
  localToday, fmtDay, minutesOf, fmtHM, isPast, isToday, STATUS_COLOR, flightAlpha, STATUS,
  FlightDot, ConditionTag, StatusPill, Tag, StandbyTag, HighlightBar, GndBadge, LeaveBadge,
  DateCalendarPopup, DateCalendarTrigger, RefreshButton, FilterBar, InlineSettings, Drawer,
  ViewIcon, FocusControls, LastUpdate,
});

