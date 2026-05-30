// Live Ops Board — departure-board style table
const { useMemo: useM_b, useState: useS_b } = React;

const brdHours  = h => h >= 10 ? h.toFixed(0) : h.toFixed(1);
const brdFlownMin = f => {
  if (f.status !== 'Completed') return 0;
  if (f.airborne) { const [h,m]=String(f.airborne).split(':').map(Number); return (h||0)*60+(m||0); }
  return f.durMin || 0;
};

const SORT_KEYS = {
  start:      f => minutesOf(f.start) ?? 9999,
  end:        f => minutesOf(f.end)   ?? 9999,
  dur:        f => f.durMin ?? 0,
  batch:      f => f.batch ?? '',
  student:    f => f.student ?? '',
  instructor: f => f.instructor ?? '',
  type:       f => f.type ?? '',
  tail:       f => f.tail ?? '',
  lesson:     f => f.lesson ?? '',
  status:     f => f.status ?? '',
};

function StatHero({ label, value, color, small=false, sub='' }) {
  return (
    <div style={{ flex:1, padding: small?'4px 8px':'6px 10px', background:'var(--surface)', border:'1px solid var(--line)', borderRadius:5, position:'relative', overflow:'hidden', minWidth: small?56:72 }}>
      <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:color }}/>
      <div className="mono uc" style={{ fontSize:small?7:8, color:'var(--ink-3)' }}>{label}</div>
      <div className="num" style={{ fontSize:small?16:22, fontWeight:600, lineHeight:1.1, marginTop:1, color:'var(--ink)' }}>{String(value).padStart(2,'0')}</div>
      {sub && <div className="mono uc" style={{ fontSize:small?6:7, color:'var(--ink-3)', marginTop:1 }}>{sub}</div>}
    </div>
  );
}

function OpsBoard() {
  const app = useApp();
  const { isMobile } = app;
  const flights = app.dayFlights;
  const [sortCol, setSortCol] = useS_b('start');
  const [sortDir, setSortDir] = useS_b('asc');

  const handleSort = col => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortCol('start'); setSortDir('asc'); }
    } else { setSortCol(col); setSortDir('asc'); }
  };

  const sorted = useM_b(() => {
    const arr = [...flights];
    const fn = SORT_KEYS[sortCol] || (f => minutesOf(f.start) ?? 0);
    arr.sort((a, b) => {
      const va = fn(a), vb = fn(b);
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [flights, sortCol, sortDir]);

  const stats = useM_b(()=>{
    const s={Pending:0,Completed:0,Canceled:0,total:flights.length,
             sim:0,ap127:0,standby:0,
             totalHours:0,completedHours:0,pendingHours:0,canceledHours:0,
             simHours:0,ap127Hours:0,standbyHours:0};
    flights.forEach(f=>{
      s[f.status]=(s[f.status]||0)+1;
      if(f.isSim)     { s.sim++;     s.simHours     +=(f.durMin||0)/60; }
      if(f.batch===HIGHLIGHT_BATCH) { s.ap127++; s.ap127Hours+=(f.durMin||0)/60; }
      if(f.isStandby) { s.standby++; s.standbyHours +=(f.durMin||0)/60; }
      s.totalHours += (f.durMin||0)/60;
      if(f.status==='Completed') s.completedHours += brdFlownMin(f)/60;
      if(f.status==='Pending')   s.pendingHours   += (f.durMin||0)/60;
      if(f.status==='Canceled')  s.canceledHours  += (f.durMin||0)/60;
    });
    return s;
  },[flights]);

  const { wd, mo, day } = fmtDay(app.date);
  const leaveMap = React.useMemo(() => leavesOnDate(app.date), [app.date]);

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>
      {/* Top bar */}
      <div style={{ minHeight:38, padding:'0 16px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', alignItems:'center', gap:10, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ width:8,height:8,borderRadius:999,background:'var(--col-done)',boxShadow:'0 0 8px var(--col-done)', animation:'pulse 2s ease-in-out infinite' }}/>
          <ViewIcon id="board" size={12} color="var(--ink-2)"/>
          <div className="mono uc" style={{ fontSize:11, fontWeight:600 }}>BOARD</div>
        </div>
        <div style={{flex:1}}/>
        <FocusControls/>
        <div className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>{FLIGHTS.length} FLIGHTS</div>
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Date hero + stats */}
      <div style={{ padding: isMobile?'4px 8px 3px':'6px 10px 4px', display:'flex', gap:isMobile?4:8, alignItems:'center', flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:6, marginRight:4 }}>
          <div className="num" style={{ fontSize:isMobile?26:38, fontWeight:700, lineHeight:1, letterSpacing:'-0.02em' }}>{String(day).padStart(2,'0')}</div>
          <div className="mono uc" style={{ fontSize:isMobile?9:11, color:'var(--ink-2)' }}>{mo} · {wd}</div>
        </div>
        <StatHero label="TOTAL"     value={stats.total}     color="var(--col-pending)" small={isMobile} sub={`${brdHours(stats.totalHours)}H SCHED`}/>
        <StatHero label="PENDING"   value={stats.Pending}   color="var(--col-pending)" small={isMobile} sub={`${brdHours(stats.pendingHours)}H`}/>
        <StatHero label="COMPLETED" value={stats.Completed} color="var(--col-done)"    small={isMobile} sub={`${brdHours(stats.completedHours)}H ✓`}/>
        <StatHero label="CANCELED"  value={stats.Canceled}  color="var(--col-cancel)"  small={isMobile} sub={`${brdHours(stats.canceledHours)}H`}/>
        <StatHero label="AP-127"    value={stats.ap127}     color="var(--highlight)"   small={isMobile} sub={`${brdHours(stats.ap127Hours)}H`}/>
        <StatHero label="STANDBY"   value={stats.standby}   color="var(--col-stby)"    small={isMobile} sub={`${brdHours(stats.standbyHours)}H`}/>
        <StatHero label="SIM"       value={stats.sim}       color="var(--col-sim)"     small={isMobile} sub={`${brdHours(stats.simHours)}H`}/>
      </div>

      {/* Date + filter */}
      <div style={{ padding: isMobile?'0 8px 4px':'0 10px 4px', display:'flex', flexDirection:'column', gap:4, flexShrink:0 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <DateCalendarTrigger/>
          <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>SELECT DATE</span>
        </div>
        <FilterBar/>
      </div>

      {/* Table */}
      <div style={{ margin: isMobile?'0 4px 4px':'0 6px 6px', flex:1, minHeight:0, border:'1px solid var(--line)', borderRadius:6, background:'var(--surface)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ flex:1, minHeight:0, overflow:'auto' }}>
          {/* Sticky header */}
          <div className="mono uc" style={{
            display:'grid', gridTemplateColumns:'110px 90px 1.3fr 1.3fr 100px 68px 52px 68px 76px 105px',
            minWidth:900, gap:10, padding:'7px 16px', fontSize:9, color:'var(--ink-3)',
            borderBottom:'1px solid var(--line)', background:'var(--bg-2)',
            position:'sticky', top:0, zIndex:1,
          }}>
            {[['status','STATUS'],['batch','BATCH'],['student','STUDENT'],['instructor','INSTRUCTOR'],['lesson','LESSON'],['start','START'],['dur','DUR'],['end','END'],['type','A/C'],['tail','TAIL']].map(([k,label])=>(
              <span key={k} onClick={()=>handleSort(k)}
                title={`Sort by ${label.toLowerCase()}${sortCol===k ? (sortDir==='asc'?' (click for descending)':' (click to reset)') : ''}`}
                onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'}
                onMouseLeave={e=>e.currentTarget.style.color=sortCol===k?'var(--col-pending)':'var(--ink-3)'}
                style={{ cursor:'pointer', userSelect:'none', display:'flex', alignItems:'center', gap:3,
                  color: sortCol===k ? 'var(--col-pending)' : 'var(--ink-3)',
                  transition:'color .1s',
              }}>
                {label}
                {sortCol===k && <span style={{fontSize:8}}>{sortDir==='asc'?'▲':'▼'}</span>}
              </span>
            ))}
          </div>
          {sorted.length===0 && (
            <div className="mono uc" style={{ padding:40, textAlign:'center', color:'var(--ink-3)', fontSize:10 }}>No flights match current filters.</div>
          )}
          {sorted.map((f,i)=>{
            const color = STATUS_COLOR(f);
            const alpha = flightAlpha(f, app.highlightAP127);
            const dim   = f.status==='Canceled';
            return (
              <div key={f.id+i} onClick={()=>app.setDrawer(f.id)}
                style={{
                  position:'relative',
                  display:'grid', gridTemplateColumns:'110px 90px 1.3fr 1.3fr 100px 68px 52px 68px 76px 105px',
                  minWidth:900, gap:10, padding:'7px 16px', alignItems:'center',
                  borderBottom:'1px solid var(--line-soft)',
                  background: i%2?'transparent':'color-mix(in oklch,var(--ink) 1.5%,transparent)',
                  borderLeft:`3px solid ${color}`,
                  cursor:'pointer', opacity:dim?alpha*0.5:alpha,
                  transition:'opacity .15s, background .12s',
                }}
                onMouseEnter={e=>e.currentTarget.style.background='color-mix(in oklch,var(--ink) 5%,transparent)'}
                onMouseLeave={e=>e.currentTarget.style.background=i%2?'transparent':'color-mix(in oklch,var(--ink) 1.5%,transparent)'}>
                <span style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
                  <StatusPill status={f.status}/>
                  {f.isStandby&&<StandbyTag/>}
                  {f.isSim&&<Tag color="var(--col-sim)" mono>SIM</Tag>}
                </span>
                <span className="mono uc"  style={{ fontSize:10, color:f.batch===HIGHLIGHT_BATCH?'var(--highlight)':'var(--ink-2)', fontWeight:f.batch===HIGHLIGHT_BATCH?600:500 }}>{f.batch}</span>
                <span style={{ fontSize:12, minWidth:0, display:'flex', alignItems:'center', gap:4, overflow:'hidden' }}>
                  <span style={{ overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{f.student||'—'}</span>
                  {f.student && leaveMap[f.student] && <LeaveBadge reason={leaveMap[f.student]}/>}
                </span>
                <span style={{ fontSize:12, color:'var(--ink-2)', minWidth:0, display:'flex', alignItems:'center', gap:4, overflow:'hidden' }}>
                  <span style={{ overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{f.instructor||'—'}</span>
                  {f.instructor && leaveMap[f.instructor] && <LeaveBadge reason={leaveMap[f.instructor]}/>}
                </span>
                <span className="mono" style={{ fontSize:11, color:'var(--ink-2)', minWidth:0, overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{f.lesson}</span>
                <span className="mono num" style={{ fontSize:13,fontWeight:600 }}>{f.start}</span>
                <span className="mono num" style={{ fontSize:11,color:'var(--ink-3)' }}>{f.duration||''}</span>
                <span className="mono num" style={{ fontSize:12,color:'var(--ink-2)' }}>{f.end}</span>
                <span className="mono" style={{ fontSize:11, color:'var(--ink-2)' }}>{f.type}</span>
                <span style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <span className="mono" style={{ fontSize:11, padding:'2px 5px', borderRadius:3, background:'var(--bg-2)', border:`1px solid ${isTailMaint(f.tail)?'var(--col-cancel)':'var(--line)'}`, color:isTailMaint(f.tail)?'var(--col-cancel)':'var(--ink)', display:'inline-block', textAlign:'center', fontWeight:isTailMaint(f.tail)?600:400 }}>{f.tail||'TBD'}</span>
                  {isTailMaint(f.tail) && <GndBadge/>}
                </span>
              </div>
            );
          })}
        </div>
        {/* Footer legend */}
        <div className="mono uc" style={{ padding:'7px 16px', fontSize:9, color:'var(--ink-3)', borderTop:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', gap:16, alignItems:'center', flexShrink:0, flexWrap:'wrap' }}>
          <span>{sorted.length} ROWS · CLICK ROW FOR DETAILS</span>
          <span style={{flex:1}}/>
          {[['PENDING','var(--col-pending)'],['COMPLETED','var(--col-done)'],['CANCELED','var(--col-cancel)'],['SIM','var(--col-sim)'],['STANDBY','var(--col-stby)']].map(([l,c])=>(
            <span key={l} style={{ display:'flex',gap:5,alignItems:'center' }}>
              <span style={{ width:8,height:8,borderRadius:2,background:c }}/>
              {l}
            </span>
          ))}
          <span style={{ display:'flex',gap:5,alignItems:'center' }}><GndBadge/> MAINTENANCE</span>
          <span style={{ display:'flex',gap:5,alignItems:'center' }}><LeaveBadge reason="On Leave"/> ON LEAVE</span>
        </div>
      </div>
      <Drawer/>
    </ArtboardShell>
  );
}

window.OpsBoard = OpsBoard;
