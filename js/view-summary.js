// Analytics Summary — batch breakdown, instructor load, AP-127 spotlight
const { useMemo: useM_s, useState: useS_s } = React;

// Helper: actual flown minutes for a completed flight (airborne if available, else scheduled)
const flownMin_s = f => {
  if (f.status !== 'Completed') return 0;
  if (f.airborne) { const [h,m]=String(f.airborne).split(':').map(Number); return (h||0)*60+(m||0); }
  return f.durMin || 0;
};

// Palette for non-AP-127 AP batches (pink/320 intentionally excluded — reserved for AP-127 highlight)
const BATCH_COLORS = [
  'oklch(0.72 0.18 260)',  // blue
  'oklch(0.75 0.18 145)',  // green
  'oklch(0.80 0.16  75)',  // amber
  'oklch(0.72 0.16  30)',  // red-orange
  'oklch(0.70 0.14 200)',  // teal
  'oklch(0.74 0.15 290)',  // purple
  'oklch(0.72 0.18 175)',  // mint
];

// Simple SVG donut chart
function DonutChart({ slices, size=150, ring=22 }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total === 0) return (
    <div style={{ width:size,height:size,display:'flex',alignItems:'center',justifyContent:'center' }}>
      <span className="mono uc" style={{ fontSize:9,color:'var(--ink-3)' }}>NO DATA</span>
    </div>
  );
  const r   = (size - ring) / 2;
  const cx  = size / 2;
  const cy  = size / 2;
  const C   = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} style={{ transform:'rotate(-90deg)', flexShrink:0 }}>
      {slices.map((s, i) => {
        const frac = s.value / total;
        const dash = frac * C;
        const gap  = C - dash;
        const el = (
          <circle key={s.label}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={ring}
            strokeDasharray={`${dash} ${gap}`}
            strokeDashoffset={-offset * C}
            opacity={0.88}
          />
        );
        offset += frac;
        return el;
      })}
      <circle cx={cx} cy={cy} r={r - ring/2 - 4} fill="var(--bg-2)" opacity={0.6}/>
    </svg>
  );
}

// barMode: 'flights' | 'hours'
// Bar container width ∝ selected metric; inner coloured segments flex-proportional to flight-count per status
function BreakdownTable({ title, subtitle, rows, nameKey='batch', barMode='flights', highlightKey=null }) {
  const sorted = [...rows].sort((a, b) =>
    barMode === 'hours' ? (b.completedHours||0) - (a.completedHours||0) : b.total - a.total
  );
  const maxFlights = Math.max(...sorted.map(r => r.total), 1);
  const maxHours   = Math.max(...sorted.map(r => r.completedHours||0), 0.01);
  const todayLeaves = leavesOnDate(localToday());

  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
      <div style={{ padding:'8px 16px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)' }}>
        <div className="mono uc" style={{ fontSize:10,color:'var(--ink)',fontWeight:600 }}>{title}</div>
        {subtitle && <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)',marginTop:1 }}>{subtitle}</div>}
      </div>
      <div style={{ padding:'10px 16px', display:'flex', flexDirection:'column', gap:8 }}>
        {sorted.length === 0 && <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)',padding:'8px 0' }}>NO DATA</div>}
        {sorted.map(r => {
          const name  = r[nameKey];
          const isHL  = name === HIGHLIGHT_BATCH || name === highlightKey;
          const barW  = barMode === 'hours'
            ? `${(((r.completedHours||0) / maxHours) * 100).toFixed(1)}%`
            : `${((r.total   / maxFlights) * 100).toFixed(1)}%`;
          return (
            <div key={name} style={{ display:'flex', gap:10, alignItems:'center' }}>
              <div style={{ width:120, flexShrink:0, display:'flex', alignItems:'center', gap:4, overflow:'hidden' }}>
                <span className="mono uc" style={{
                  fontSize:10,
                  color: isHL ? 'var(--highlight)' : 'var(--ink-2)',
                  fontWeight: isHL ? 600 : 400,
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                }} title={name}>{name}</span>
                {nameKey !== 'batch' && todayLeaves[name] && <LeaveBadge reason={todayLeaves[name]}/>}
              </div>
              {/* Bar track */}
              <div style={{ flex:1, height:18, background:'var(--bg-2)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ width:barW, height:'100%', display:'flex', gap:1, transition:'width .3s' }}>
                  {r.pending   > 0 && <div title={`Pending: ${r.pending}`}   style={{ flex:r.pending,   background:'var(--col-pending)', opacity:.85 }}/>}
                  {r.completed > 0 && <div title={`Completed: ${r.completed}`} style={{ flex:r.completed, background:'var(--col-done)',    opacity:.85 }}/>}
                  {r.canceled  > 0 && <div title={`Canceled: ${r.canceled}`}  style={{ flex:r.canceled,  background:'var(--col-cancel)',  opacity:.85 }}/>}
                  {r.standby   > 0 && <div title={`Standby: ${r.standby}`}    style={{ flex:r.standby,   background:'var(--col-stby)',    opacity:.85 }}/>}
                  {r.total === 0   && <div style={{ flex:1, background:'var(--line)', opacity:.2 }}/>}
                </div>
              </div>
              {/* Completed / Canceled counts + completed hours */}
              <div style={{ display:'flex', gap:4, alignItems:'center', flexShrink:0 }}>
                <div className="mono num" style={{ fontSize:9, color:'var(--col-done)', textAlign:'right', width:20 }} title="Completed">{r.completed}</div>
                <div className="mono" style={{ fontSize:8, color:'var(--ink-3)' }}>/</div>
                <div className="mono num" style={{ fontSize:9, color:'var(--col-cancel)', textAlign:'right', width:20 }} title="Canceled">{r.canceled}</div>
                <div className="mono num" style={{ width:52, fontSize:9, color:'var(--col-done)', textAlign:'right' }} title="Completed hours">✓{(r.completedHours||0).toFixed(1)}h</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryBoard() {
  const app = useApp();
  const { isMobile } = app;
  const [dateFrom, setDateFrom] = useS_s(()=>{
    const today = localToday();
    const weekAgo = new Date(new Date(today+'T00:00:00').getTime() - 7*86400000);
    const weekAgoStr = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth()+1).padStart(2,'0')}-${String(weekAgo.getDate()).padStart(2,'0')}`;
    return ALL_DATES.find(d => d >= weekAgoStr) || ALL_DATES[0];
  });
  const [dateTo, setDateTo] = useS_s(()=>{
    const today = localToday();
    return [...ALL_DATES].reverse().find(d => d <= today) || ALL_DATES[ALL_DATES.length-1];
  });
  const [barMode, setBarMode] = useS_s('hours'); // 'flights' | 'hours'

  const all = useM_s(()=> {
    return FLIGHTS.filter(f => {
      if (!app.tweaks.showSim && f.isSim) return false;
      if (f.date < dateFrom || f.date > dateTo) return false;
      return true;
    });
  }, [app.tweaks.showSim, dateFrom, dateTo]);

  const totalStats = useM_s(()=>{
    const s={total:all.length,pending:0,completed:0,canceled:0,standby:0,sim:0,hours:0};
    all.forEach(f=>{
      if(f.status==='Pending')   s.pending++;
      if(f.status==='Completed') s.completed++;
      if(f.status==='Canceled')  s.canceled++;
      if(f.isStandby) s.standby++;
      if(f.isSim)     s.sim++;
      s.hours += (f.durMin||0)/60;
    });
    return s;
  },[all]);

  const batchStats = useM_s(()=>{
    const m={};
    all.forEach(f=>{
      const b=f.batch||'Unknown';
      if(!m[b]) m[b]={batch:b,total:0,pending:0,completed:0,canceled:0,hours:0,completedHours:0,standby:0};
      m[b].total++; m[b].hours+=(f.durMin||0)/60;
      m[b].completedHours += flownMin_s(f)/60;
      if(f.status==='Pending')   m[b].pending++;
      if(f.status==='Completed') m[b].completed++;
      if(f.status==='Canceled')  m[b].canceled++;
      if(f.isStandby)            m[b].standby++;
    });
    return Object.values(m);
  },[all]);

  const instrStats = useM_s(()=>{
    const m={};
    all.forEach(f=>{
      const k=f.instructor||'—';
      if(!m[k]) m[k]={name:k,total:0,hours:0,completedHours:0,pending:0,completed:0,canceled:0,standby:0};
      m[k].total++; m[k].hours+=(f.durMin||0)/60;
      m[k].completedHours += flownMin_s(f)/60;
      if(f.status==='Pending')   m[k].pending++;
      if(f.status==='Completed') m[k].completed++;
      if(f.status==='Canceled')  m[k].canceled++;
      if(f.isStandby)            m[k].standby++;
    });
    return Object.values(m);
  },[all]);

  const studentStats = useM_s(()=>{
    const m={};
    all.forEach(f=>{
      if(!f.student) return;  // skip flights with no named student
      const k=f.student;
      if(!m[k]) m[k]={name:k,total:0,hours:0,completedHours:0,pending:0,completed:0,canceled:0,standby:0};
      m[k].total++; m[k].hours+=(f.durMin||0)/60;
      m[k].completedHours += flownMin_s(f)/60;
      if(f.status==='Pending')   m[k].pending++;
      if(f.status==='Completed') m[k].completed++;
      if(f.status==='Canceled')  m[k].canceled++;
      if(f.isStandby)            m[k].standby++;
    });
    return Object.values(m);
  },[all]);

  // AP-127 students: seed all known AP-127 students from full FLIGHTS so 0-hr students appear
  const ap127StudentStats = useM_s(()=>{
    const m={};
    // Seed every known AP-127 student from entire dataset
    FLIGHTS.filter(f => f.batch === HIGHLIGHT_BATCH && f.student).forEach(f => {
      const k = f.student;
      if (!m[k]) m[k] = {name:k, total:0, hours:0, completedHours:0, pending:0, completed:0, canceled:0, standby:0};
    });
    // Accumulate from the active date range
    all.filter(f => f.batch === HIGHLIGHT_BATCH).forEach(f => {
      const k = f.student || '—';
      if (!m[k]) m[k] = {name:k, total:0, hours:0, completedHours:0, pending:0, completed:0, canceled:0, standby:0};
      m[k].total++; m[k].hours += (f.durMin||0)/60;
      m[k].completedHours += flownMin_s(f)/60;
      if(f.status==='Pending')   m[k].pending++;
      if(f.status==='Completed') m[k].completed++;
      if(f.status==='Canceled')  m[k].canceled++;
      if(f.isStandby)            m[k].standby++;
    });
    return Object.values(m).sort((a,b) => (b.completedHours||0) - (a.completedHours||0) || b.total - a.total || a.name.localeCompare(b.name));
  },[all]);

  // AP-batch pie: only batches starting with "AP-"
  const apBatchSlices = useM_s(()=>{
    const apBatches = batchStats.filter(b => /^AP-/i.test(b.batch));
    apBatches.sort((a,b) => a.batch.localeCompare(b.batch));
    let colorIdx = 0;
    return apBatches.map(b => {
      if (b.batch === HIGHLIGHT_BATCH) {
        return { label:b.batch, value:b.total, hours:b.hours, color:'var(--highlight)' };
      }
      const color = BATCH_COLORS[colorIdx % BATCH_COLORS.length];
      colorIdx++;
      return { label:b.batch, value:b.total, hours:b.hours, color };
    });
  }, [batchStats]);

  const SumTile = ({label,value,color,sub}) => (
    <div style={{ flex:1, padding:'8px 12px', background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, borderTop:`2px solid ${color}`, minWidth:80 }}>
      <div className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>{label}</div>
      <div className="num" style={{ fontSize:24,fontWeight:600,lineHeight:1.1,color:'var(--ink)',marginTop:2 }}>{String(value).padStart(2,'0')}</div>
      {sub&&<div className="mono uc" style={{ fontSize:8,color:'var(--ink-3)',marginTop:2 }}>{sub}</div>}
    </div>
  );

  const BarModeChip = ({ mode, label }) => (
    <button onClick={() => setBarMode(mode)} className="mono uc" style={{
      padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
      border:`1px solid ${barMode===mode?'var(--ink-2)':'var(--line)'}`,
      background: barMode===mode ? `color-mix(in oklch,var(--ink-2) 14%,var(--surface))` : 'transparent',
      color: barMode===mode ? 'var(--ink-2)' : 'var(--ink-3)',
      fontWeight: barMode===mode ? 600 : 400, transition:'all .1s',
    }}>{label}</button>
  );

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>
      {/* Header — compact single strip */}
      <div style={{ minHeight:38, padding:'0 16px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', alignItems:'center', gap:8, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex',alignItems:'center',gap:7 }}>
          <span style={{ width:8,height:8,borderRadius:999,background:'var(--col-pending)',boxShadow:'0 0 8px var(--col-pending)' }}/>
          <ViewIcon id="summary" size={12} color="var(--ink-2)"/>
          <div className="mono uc" style={{ fontSize:11,fontWeight:600 }}>ANALYTICS</div>
        </div>
        {/* Date range inline */}
        <div style={{ display:'flex', gap:6, alignItems:'center', marginLeft:8 }}>
          {[['FROM', dateFrom, setDateFrom], ['TO', dateTo, setDateTo]].map(([lbl, val, setter])=>(
            <label key={lbl} style={{ display:'flex', alignItems:'center', gap:4 }}>
              <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>{lbl}</span>
              <select className="mono" value={val} onChange={e=>setter(e.target.value)}
                style={{ background:'var(--surface)', color:'var(--ink)', border:'1px solid var(--line)', borderRadius:4, padding:'2px 6px', fontSize:10, outline:'none' }}>
                {ALL_DATES.map(d=>{ const {wd,mo,day}=fmtDay(d); return <option key={d} value={d}>{wd} {String(day).padStart(2,'0')} {mo}</option>; })}
              </select>
            </label>
          ))}
          <button className="mono uc" onClick={()=>{ setDateFrom(ALL_DATES[0]); setDateTo(ALL_DATES[ALL_DATES.length-1]); }}
            style={{ fontSize:8, padding:'2px 6px', borderRadius:4, border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)', cursor:'pointer' }}>
            ALL
          </button>
        </div>
        <div style={{flex:1}}/>
        <FocusControls/>
        <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>{all.length} FLT</span>
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Body: scrollable data area */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto' }}>
      <div style={{ padding:'10px 10px 20px', display:'flex', flexDirection:'column', gap:12 }}>

        {/* Stat tiles */}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <SumTile label="TOTAL" value={totalStats.total} color="var(--ink-2)" sub={`${totalStats.hours.toFixed(0)}h`}/>
          <SumTile label="PENDING"   value={totalStats.pending}   color="var(--col-pending)"/>
          <SumTile label="COMPLETED" value={totalStats.completed} color="var(--col-done)"/>
          <SumTile label="CANCELED"  value={totalStats.canceled}  color="var(--col-cancel)"/>
          <SumTile label="STANDBY"   value={totalStats.standby}   color="var(--col-stby)"/>
          <SumTile label="SIM"       value={totalStats.sim}       color="var(--col-sim)"/>
        </div>

        {/* AP Batch Pie + AP-127 Student breakdown */}
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap:16, alignItems:'start' }}>

          {/* Donut chart card */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
            <div style={{ padding:'8px 16px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)' }}>
              <div className="mono uc" style={{ fontSize:10,color:'var(--ink)',fontWeight:600 }}>AP BATCH COMPARISON</div>
              <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)',marginTop:1 }}>TOTAL FLIGHTS PER BATCH</div>
            </div>
            <div style={{ padding:'16px', display:'flex', gap:20, alignItems:'center', flexWrap:'wrap' }}>
              <DonutChart slices={apBatchSlices} size={isMobile?120:150} ring={20}/>
              {/* Legend */}
              <div style={{ display:'flex', flexDirection:'column', gap:6, flex:1, minWidth:120 }}>
                {apBatchSlices.map(s => (
                  <div key={s.label} style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ width:10, height:10, borderRadius:2, background:s.color, flexShrink:0 }}/>
                    <span className="mono uc" style={{ fontSize:10, color: s.label===HIGHLIGHT_BATCH?'var(--highlight)':'var(--ink-2)', fontWeight: s.label===HIGHLIGHT_BATCH?600:400, flex:1 }}>{s.label}</span>
                    <span className="mono num" style={{ fontSize:10, color:'var(--ink-3)' }}>{s.value}</span>
                    <span className="mono" style={{ fontSize:9, color:'var(--ink-3)', minWidth:36, textAlign:'right' }}>{s.hours.toFixed(1)}h</span>
                  </div>
                ))}
                {apBatchSlices.length === 0 && <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)' }}>NO AP BATCHES IN RANGE</div>}
              </div>
            </div>
          </div>

          {/* AP-127 student breakdown — uses barMode */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--highlight)', borderRadius:8, overflow:'hidden' }}>
            <div style={{ padding:'8px 16px', borderBottom:'1px solid var(--line)', background:'color-mix(in oklch,var(--highlight) 8%,var(--bg-2))' }}>
              <div className="mono uc" style={{ fontSize:10,color:'var(--highlight)',fontWeight:600 }}>◆ AP-127 STUDENTS</div>
              <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)',marginTop:1 }}>ALL COHORT MEMBERS · SORTED BY {barMode==='hours'?'HOURS':'FLIGHTS'}</div>
            </div>
            <div style={{ padding:'10px 16px', display:'flex', flexDirection:'column', gap:8 }}>
              {ap127StudentStats.length === 0 && <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)',padding:'8px 0' }}>NO AP-127 STUDENTS FOUND</div>}
              {(()=>{
                const sorted127 = [...ap127StudentStats].sort((a,b) =>
                  barMode === 'hours' ? (b.completedHours||0) - (a.completedHours||0) : b.total - a.total
                );
                const maxF127 = Math.max(...sorted127.map(r=>r.total), 1);
                const maxH127 = Math.max(...sorted127.map(r=>r.completedHours||0), 0.01);
                return sorted127.map(r => {
                  const barW = barMode === 'hours'
                    ? `${(((r.completedHours||0) / maxH127) * 100).toFixed(1)}%`
                    : `${((r.total / maxF127) * 100).toFixed(1)}%`;
                  return (
                    <div key={r.name} style={{ display:'flex', gap:10, alignItems:'center' }}>
                      <div style={{ width:120, flexShrink:0, display:'flex', alignItems:'center', gap:4, overflow:'hidden' }}>
                        <span className="mono uc" style={{ fontSize:10,color:'var(--highlight)',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }} title={r.name}>{r.name}</span>
                        {leavesOnDate(localToday())[r.name] && <LeaveBadge reason={leavesOnDate(localToday())[r.name]}/>}
                      </div>
                      <div style={{ flex:1, height:18, background:'var(--bg-2)', borderRadius:3, overflow:'hidden' }}>
                        <div style={{ width:barW, height:'100%', display:'flex', gap:1, transition:'width .3s' }}>
                          {r.pending   > 0 && <div title={`Pending: ${r.pending}`}   style={{ flex:r.pending,   background:'var(--col-pending)', opacity:.85 }}/>}
                          {r.completed > 0 && <div title={`Completed: ${r.completed}`} style={{ flex:r.completed, background:'var(--col-done)',    opacity:.85 }}/>}
                          {r.canceled  > 0 && <div title={`Canceled: ${r.canceled}`}  style={{ flex:r.canceled,  background:'var(--col-cancel)',  opacity:.85 }}/>}
                          {r.standby   > 0 && <div title={`Standby: ${r.standby}`}    style={{ flex:r.standby,   background:'var(--col-stby)',    opacity:.85 }}/>}
                          {r.total === 0   && <div style={{ flex:1, background:'var(--line)', opacity:.2 }}/>}
                        </div>
                      </div>
                      {/* Completed / Canceled + completed hours */}
                      <div style={{ display:'flex', gap:4, alignItems:'center', flexShrink:0 }}>
                        <div className="mono num" style={{ fontSize:9,color:'var(--col-done)',textAlign:'right',width:20 }} title="Completed">{r.completed}</div>
                        <div className="mono" style={{ fontSize:8,color:'var(--ink-3)' }}>/</div>
                        <div className="mono num" style={{ fontSize:9,color:'var(--col-cancel)',textAlign:'right',width:20 }} title="Canceled">{r.canceled}</div>
                        <div className="mono num" style={{ width:52,fontSize:9,color:'var(--col-done)',textAlign:'right' }} title="Completed hours">✓{(r.completedHours||0).toFixed(1)}h</div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>

        {/* Bar mode toggle + breakdown section header */}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'4px 0' }}>
          <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>BREAKDOWN BY</span>
          <BarModeChip mode="flights" label="# FLIGHTS"/>
          <BarModeChip mode="hours"   label="HOURS"/>
        </div>

        {/* Batch breakdown */}
        <BreakdownTable title="BATCH BREAKDOWN" subtitle="PENDING · COMPLETED · CANCELED · STANDBY" rows={batchStats} nameKey="batch" barMode={barMode}/>

        {/* Instructor breakdown */}
        <BreakdownTable title="INSTRUCTOR BREAKDOWN" subtitle="PENDING · COMPLETED · CANCELED · STANDBY" rows={instrStats} nameKey="name" barMode={barMode}/>

        {/* Student breakdown */}
        <BreakdownTable title="STUDENT BREAKDOWN" subtitle="PENDING · COMPLETED · CANCELED · STANDBY" rows={studentStats} nameKey="name" barMode={barMode}/>

      </div>{/* end inner flex column */}
      </div>{/* end scroll container */}
      <Drawer/>
    </ArtboardShell>
  );
}

window.SummaryBoard = SummaryBoard;
