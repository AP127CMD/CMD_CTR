// Gantt timeline — rows = instructor / tail / batch
const { useMemo: useM_g } = React;

const HOUR_START = 6;
const HOUR_END   = 18;
const HOUR_SPAN  = HOUR_END - HOUR_START;
// Compact 12-hour label for tight mobile rulers, e.g. 6 -> "6AM", 13 -> "1PM"
const fmtHour = h => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'AM' : 'PM'}`;

function GanttBoard() {
  const app      = useApp();
  const { isMobile } = app;
  const flights  = app.dayFlights;
  const groupBy  = app.tweaks.groupBy || 'instructor';
  const TRACK_LEFT  = isMobile ? 90  : 190;
  const TRACK_RIGHT = isMobile ? 64  : 180;

  const rows = useM_g(()=>{
    const map = {};
    flights.forEach(f=>{
      const key = (groupBy==='instructor'?f.instructor:groupBy==='tail'?f.tail:f.batch)||'—';
      (map[key]||=[]).push(f);
    });
    return Object.entries(map)
      .map(([k,v])=>({ key:k, flights:v.sort((a,b)=>(minutesOf(a.start)||0)-(minutesOf(b.start)||0)) }))
      .sort((a,b)=>{
        // Tail focus: sort by aircraft type first, then tail number alphabetically
        if (groupBy === 'tail') {
          const aType = a.flights[0]?.type || '';
          const bType = b.flights[0]?.type || '';
          if (aType !== bType) return aType.localeCompare(bType);
        }
        return a.key.localeCompare(b.key);
      });
  },[flights,groupBy]);

  const { wd, mo, day } = fmtDay(app.date);

  const GrpChip = ({ g }) => (
    <button onClick={()=>app.setTweak('groupBy',g)} className="mono uc" style={{
      padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
      border:`1px solid ${app.tweaks.groupBy===g?'var(--ink-2)':'var(--line)'}`,
      background:app.tweaks.groupBy===g?`color-mix(in oklch,var(--ink-2) 14%,var(--surface))`:'transparent',
      color:app.tweaks.groupBy===g?'var(--ink-2)':'var(--ink-3)',
      fontWeight:app.tweaks.groupBy===g?600:400, transition:'all .1s',
    }}>{g}</button>
  );

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>
      {/* Header */}
      <div style={{ padding:'0 16px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', alignItems:'center', gap:8, flexShrink:0, minHeight:38, flexWrap:'wrap' }}>
        <div style={{ display:'flex',alignItems:'center',gap:8 }}>
          <span style={{ width:8,height:8,borderRadius:999,background:'var(--col-pending)',boxShadow:'0 0 8px var(--col-pending)' }}/>
          <ViewIcon id="gantt" size={12} color="var(--ink-2)"/>
          <div className="mono uc" style={{ fontSize:11,fontWeight:600 }}>GANTT</div>
        </div>
        <div style={{ display:'flex',gap:4,alignItems:'center' }}>
          <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>FOCUS</span>
          <GrpChip g="instructor"/>
          <GrpChip g="tail"/>
          <GrpChip g="batch"/>
        </div>
        <div style={{flex:1}}/>
        <FocusControls/>
        {!isMobile && <div className="mono num" style={{ fontSize:11,color:'var(--ink-3)' }}>{String(day).padStart(2,'0')} {mo} · {wd}</div>}
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Date + filter */}
      <div style={{ padding:'4px 8px', display:'flex', flexDirection:'column', gap:4, flexShrink:0 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <DateCalendarTrigger/>
          <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>SELECT DATE</span>
        </div>
        <FilterBar/>
      </div>

      {/* Timeline */}
      <div style={{ margin:'2px 6px 6px', flex:1, minHeight:0, border:'1px solid var(--line)', borderRadius:6, background:'var(--surface)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Single scroll viewport — scrolls both axes. On mobile the inner content
            gets a min-width so the timeline isn't cramped; the hour ruler stays
            pinned to the top and the label column stays pinned to the left while
            you swipe/scroll. (One scroll container is required for position:sticky
            to track the same scroll on both axes.) */}
        <div style={{ flex:1, minHeight:0, overflow:'auto' }}>
          <div style={{ minWidth: isMobile ? 720 : 'auto' }}>
            {/* Hour ruler — sticky to the top of the viewport */}
            <div style={{ display:'grid', gridTemplateColumns:`${TRACK_LEFT}px 1fr ${TRACK_RIGHT}px`, borderBottom:'1px solid var(--line)', background:'var(--bg-2)', position:'sticky', top:0, zIndex:4 }}>
              <div className="mono uc" style={{ padding:'9px 14px', fontSize:9, color:'var(--ink-3)',
                position:'sticky', left:0, zIndex:5, background:'var(--bg-2)' }}>
                {groupBy.toUpperCase()} · {rows.length}
              </div>
              <div style={{ position:'relative', height:34, overflow:'hidden' }}>
                {Array.from({length:HOUR_SPAN+1}).map((_,i)=>{
                  const h=HOUR_START+i;
                  // On mobile only label every 3rd hour (avoids overlap)
                  const showLabel = !isMobile || h % 3 === 0;
                  return (
                    <div key={i} className="mono num" style={{
                      position:'absolute', left:`${(i/HOUR_SPAN)*100}%`, top:0, bottom:0,
                      borderLeft:i===0?'none':'1px solid var(--line-soft)',
                      paddingLeft:5, fontSize:isMobile?9:10, color:'var(--ink-3)', display:'flex', alignItems:'center',
                      whiteSpace:'nowrap',
                    }}>{showLabel ? `${h}` : ''}</div>
                  );
                })}
              </div>
              <div className="mono uc" style={{ padding:'9px 14px', fontSize:9, color:'var(--ink-3)', borderLeft:'1px solid var(--line)' }}>
                {groupBy==='instructor'?'DUTY PERIOD':groupBy==='tail'?'TAIL HRS':'BATCH HRS'}
              </div>
            </div>

            {/* Rows */}
            <div>
              {rows.map((r,ri)=>{
            const totalMin = r.flights.reduce((a,b)=>a+(b.durMin||0),0);
            const hasHL    = r.flights.some(f=>f.batch===HIGHLIGHT_BATCH);
            const rowAlpha = app.highlightAP127&&!hasHL ? 0.28 : 1;
            const dateLeaveMap = leavesOnDate(app.date);
            const rowOnLeave   = groupBy === 'instructor' && dateLeaveMap[r.key];
            const rowOnMaint   = groupBy === 'tail'       && isTailMaint(r.key);

            const rightMetric = (() => {
              if (groupBy === 'instructor') {
                const starts = r.flights.map(f=>minutesOf(f.start)).filter(v=>v!=null);
                const ends   = r.flights.map(f=>minutesOf(f.end)).filter(v=>v!=null);
                if (!starts.length) return { label:'DUTY', value:'—', sub:'' };
                const dutyMin = Math.max(...ends) - Math.min(...starts);
                const h = Math.floor(dutyMin/60), m = dutyMin%60;
                const firstStart = r.flights.reduce((a,b)=>(minutesOf(a.start)||9999)<(minutesOf(b.start)||9999)?a:b).start;
                const lastEnd    = r.flights.reduce((a,b)=>(minutesOf(a.end)||0)>(minutesOf(b.end)||0)?a:b).end;
                return { label:'DUTY', value:`${h}h${String(m).padStart(2,'0')}`, sub:`${firstStart}–${lastEnd}` };
              }
              const h = Math.floor(totalMin/60), m = totalMin%60;
              return { label: groupBy==='tail'?'TAIL HRS':'FLT HRS', value:`${h}h${String(m).padStart(2,'0')}`, sub:`${r.flights.length} FLT` };
            })();

            return (
              <div key={r.key} style={{
                display:'grid', gridTemplateColumns:`${TRACK_LEFT}px 1fr ${TRACK_RIGHT}px`,
                borderBottom:'1px solid var(--line-soft)', minHeight:54,
                background:ri%2?'transparent':'color-mix(in oklch,var(--ink) 1.2%,transparent)',
                opacity:rowAlpha, transition:'opacity .15s',
              }}>
                <div style={{ padding: isMobile?'4px 6px':'8px 10px', display:'flex', alignItems:'center', borderRight:'1px solid var(--line)', overflow:'hidden',
                  ...(isMobile ? { position:'sticky', left:0, zIndex:2, background:'var(--bg-2)' } : {}) }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:isMobile?10:12, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                      color: rowOnMaint ? 'var(--col-cancel)' : 'var(--ink)' }}>{r.key}</div>
                    <div style={{ display:'flex', gap:4, marginTop:2, flexWrap:'wrap' }}>
                      {rowOnMaint && <GndBadge/>}
                      {rowOnLeave && <LeaveBadge reason={rowOnLeave}/>}
                    </div>
                  </div>
                </div>
                <div style={{ position:'relative' }}>
                  {Array.from({length:HOUR_SPAN+1}).map((_,i)=>(
                    <div key={i} style={{ position:'absolute',left:`${(i/HOUR_SPAN)*100}%`,top:0,bottom:0,borderLeft:'1px solid var(--line-soft)',opacity:i%2?0.5:1 }}/>
                  ))}
                  {r.flights.map((f,fi)=>{
                    const startMin  = (minutesOf(f.start)||0) - HOUR_START*60;
                    const totalSpan = HOUR_SPAN*60;
                    const left      = Math.max(0,(startMin/totalSpan)*100);
                    const width     = ((f.durMin||60)/totalSpan)*100;
                    const color     = STATUS_COLOR(f);
                    const done      = f.status==='Completed';
                    const dim       = f.status==='Canceled';
                    const stby      = f.isStandby;
                    return (
                      <button key={f.id+fi} onClick={()=>app.setDrawer(f.id)}
                        title={`${f.start}–${f.end} · ${f.student} · ${f.lesson}`}
                        style={{
                          position:'absolute', left:`${left}%`, width:`calc(${width}% - 2px)`,
                          top:5, bottom:5,
                          background:`color-mix(in oklch,${color} ${stby?8:18}%,var(--surface))`,
                          border:`${stby?'1px dashed':'1px solid'} ${color}`,
                          borderLeft:`3px ${stby?'dashed':'solid'} ${color}`,
                          borderRadius:4, padding:'3px 6px', textAlign:'left',
                          cursor:'pointer', overflow:'hidden', color:'var(--ink)',
                          opacity: dim?0.4:1, textDecoration: dim?'line-through':'none',
                        }}>
                        <div className="mono num" style={{ fontSize:10,display:'flex',justifyContent:'space-between',gap:4 }}>
                          <span>{f.start}</span>
                          {done&&<span style={{color:'var(--col-done)'}}>✓</span>}
                          {stby&&<span style={{color:'var(--col-stby)',fontSize:8}}>STBY</span>}
                        </div>
                        <div style={{ fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',lineHeight:1.2 }}>{f.student}</div>
                        <div className="mono uc" style={{ fontSize:8.5,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',gap:4,alignItems:'center' }}>
                          <span style={{color:f.batch===HIGHLIGHT_BATCH?'var(--highlight)':'var(--ink-3)',fontWeight:f.batch===HIGHLIGHT_BATCH?600:400}}>{f.batch}</span>
                          <span style={{color:'var(--ink-3)'}}>·</span>
                          <span style={{color:isTailMaint(f.tail)?'var(--col-cancel)':'var(--ink-3)',fontWeight:isTailMaint(f.tail)?600:400}}>{f.tail||'TBD'}</span>
                          {isTailMaint(f.tail) && <GndBadge/>}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div style={{ padding: isMobile?'6px 8px':'10px 14px',borderLeft:'1px solid var(--line)',display:'flex',flexDirection:'column',justifyContent:'center',gap:1 }}>
                  <div className="mono uc" style={{ fontSize:isMobile?7:8,color:'var(--ink-3)' }}>{rightMetric.label}</div>
                  <div className="mono num" style={{ fontSize:isMobile?11:14,fontWeight:600,color:'var(--ink)' }}>{rightMetric.value}</div>
                  {!isMobile && <div className="mono" style={{ fontSize:9,color:'var(--ink-3)' }}>{rightMetric.sub}</div>}
                </div>
              </div>
            );
          })}
          {rows.length===0&&(
            <div className="mono uc" style={{ padding:40,textAlign:'center',color:'var(--ink-3)',fontSize:10 }}>No flights match current filters.</div>
          )}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="mono uc" style={{ display:'flex',gap:14,padding:'7px 16px',fontSize:9,color:'var(--ink-3)',borderTop:'1px solid var(--line)',background:'var(--bg-2)',flexShrink:0 }}>
          {[['PENDING','var(--col-pending)'],['COMPLETED','var(--col-done)'],['CANCELED','var(--col-cancel)'],['SIM','var(--col-sim)'],['STANDBY','var(--col-stby)']].map(([l,c])=>(
            <span key={l} style={{ display:'flex',gap:5,alignItems:'center' }}>
              <span style={{ width:12,height:7,background:`color-mix(in oklch,${c} 20%,var(--surface))`,border:`1px ${l==='STANDBY'?'dashed':'solid'} ${c}`,borderRadius:2 }}/>
              {l}
            </span>
          ))}
          <span style={{flex:1}}/>
          <span>CLICK A BAR FOR DETAILS</span>
        </div>
      </div>
      <Drawer/>
    </ArtboardShell>
  );
}

window.GanttBoard = GanttBoard;
