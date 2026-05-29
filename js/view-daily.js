// Day at a Glance — comprehensive single-day dashboard
// Shows all flight aspects for one date: KPIs, hourly schedule pulse, status mix,
// batch breakdown, instructor & fleet utilization, plus a dedicated AP-127 spotlight.
const { useMemo: useM_d, useState: useS_d } = React;

// Helpers --------------------------------------------------------------------
const hmToMin_d = hm => {
  if (!hm) return 0;
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const hoursFmt = h => h >= 10 ? h.toFixed(0) : h.toFixed(1);

// Inline SVG donut (kept local so this view is self-contained)
function DailyDonut({ slices, size = 150, ring = 22, center }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r  = (size - ring) / 2;
  const cx = size / 2, cy = size / 2;
  const C  = 2 * Math.PI * r;
  let off = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        {/* Track */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--line)" strokeWidth={ring} opacity={0.25}/>
        {total > 0 && slices.map(s => {
          const frac = s.value / total;
          if (frac === 0) return null;
          const dash = frac * C, gap = C - dash;
          const el = (
            <circle key={s.label} cx={cx} cy={cy} r={r} fill="none"
              stroke={s.color} strokeWidth={ring}
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={-off * C} opacity={0.9}
              strokeLinecap="butt"/>
          );
          off += frac;
          return el;
        })}
      </svg>
      {/* Center label */}
      <div style={{
        position: 'absolute', inset: 0, display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        {total === 0 ? (
          <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>NO DATA</span>
        ) : (
          center || (
            <>
              <span className="num" style={{ fontSize: size > 130 ? 26 : 20, fontWeight: 700, color: 'var(--ink)', lineHeight: 1 }}>{total}</span>
              <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)', marginTop: 2 }}>FLIGHTS</span>
            </>
          )
        )}
      </div>
    </div>
  );
}

// KPI tile
function DKPI({ label, value, sub, color, big = false, small = false }) {
  return (
    <div style={{
      flex: small ? '1 1 78px' : '1 1 110px',
      minWidth: small ? 66 : 84,
      padding: big ? '10px 14px' : (small ? '6px 8px' : '8px 12px'),
      background: 'var(--surface)', border: '1px solid var(--line)',
      borderRadius: 6, position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color }}/>
      <div className="mono uc" style={{ fontSize: small ? 7 : 8, color: 'var(--ink-3)' }}>{label}</div>
      <div className="num" style={{
        fontSize: big ? 28 : (small ? 17 : 22), fontWeight: 700, lineHeight: 1.05, marginTop: 2,
        color: 'var(--ink)',
      }}>{value}</div>
      {sub && <div className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// Section card
function Section({ title, hint, accent, children, fullWidth = false }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--line)',
      borderRadius: 8, overflow: 'hidden',
      gridColumn: fullWidth ? '1 / -1' : 'auto',
      display: 'flex', flexDirection: 'column', minWidth: 0,
    }}>
      <div style={{
        padding: '8px 14px', borderBottom: '1px solid var(--line)',
        background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 8,
        borderLeft: accent ? `3px solid ${accent}` : 'none',
      }}>
        <div className="mono uc" style={{ fontSize: 10, color: 'var(--ink)', fontWeight: 600 }}>{title}</div>
        {hint && <div className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', marginLeft: 'auto' }}>{hint}</div>}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  );
}

// Mini-progress bar (used in batch / instructor / aircraft rows)
function StackBar({ pending = 0, completed = 0, canceled = 0, standby = 0, max = 1, total }) {
  const t = total ?? (pending + completed + canceled + standby);
  const width = `${Math.max(2, (t / max) * 100).toFixed(1)}%`;
  return (
    <div style={{ flex: 1, height: 16, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width, height: '100%', display: 'flex', gap: 1, transition: 'width .25s' }}>
        {pending   > 0 && <div title={`Pending: ${pending}`}     style={{ flex: pending,   background: 'var(--col-pending)', opacity: .85 }}/>}
        {completed > 0 && <div title={`Completed: ${completed}`} style={{ flex: completed, background: 'var(--col-done)',    opacity: .85 }}/>}
        {canceled  > 0 && <div title={`Canceled: ${canceled}`}   style={{ flex: canceled,  background: 'var(--col-cancel)',  opacity: .85 }}/>}
        {standby   > 0 && <div title={`Standby: ${standby}`}     style={{ flex: standby,   background: 'var(--col-stby)',    opacity: .85 }}/>}
        {t === 0       && <div style={{ flex: 1, background: 'var(--line)', opacity: .2 }}/>}
      </div>
    </div>
  );
}

function DailyBoard() {
  const app = useApp();
  const { isMobile } = app;
  const date = app.date;
  const today = localToday();
  const isCurrentDay = date === today;
  const { wd, mo, day, y } = fmtDay(date);

  // Source of truth — all flights for the selected date (no filters applied here)
  const flights = useM_d(() => FLIGHTS.filter(f => f.date === date), [date]);

  // Comprehensive day stats
  const stats = useM_d(() => {
    const s = {
      total: 0, pending: 0, completed: 0, canceled: 0,
      standby: 0, sim: 0, ap127: 0,
      schedHours: 0, flownHours: 0, pendingHours: 0, canceledHours: 0, simHours: 0,
      students: new Set(), instructors: new Set(), tails: new Set(), batches: new Set(),
      // Mutually-exclusive buckets for the donut (matches STATUS_COLOR precedence)
      mix: { sim: 0, standby: 0, completed: 0, pending: 0, canceled: 0 },
    };
    flights.forEach(f => {
      s.total++;
      // Overlapping counters (consistent with the BOARD view's stat tiles)
      if (f.status === 'Pending')   s.pending++;
      if (f.status === 'Completed') s.completed++;
      if (f.status === 'Canceled')  s.canceled++;
      if (f.isStandby) s.standby++;
      if (f.isSim)     s.sim++;
      if (f.batch === HIGHLIGHT_BATCH) s.ap127++;
      // Mutually-exclusive bucket — each flight counted exactly once
      if (f.isSim)                       s.mix.sim++;
      else if (f.isStandby)              s.mix.standby++;
      else if (f.status === 'Completed') s.mix.completed++;
      else if (f.status === 'Canceled')  s.mix.canceled++;
      else                               s.mix.pending++;
      s.schedHours += (f.durMin || 0) / 60;
      if (f.status === 'Completed') {
        const minutes = f.airborne ? hmToMin_d(f.airborne) : (f.durMin || 0);
        s.flownHours += minutes / 60;
      }
      if (f.status === 'Pending')  s.pendingHours  += (f.durMin || 0) / 60;
      if (f.status === 'Canceled') s.canceledHours += (f.durMin || 0) / 60;
      if (f.isSim)                 s.simHours      += (f.durMin || 0) / 60;
      if (f.student)    s.students.add(f.student);
      if (f.instructor) s.instructors.add(f.instructor);
      if (f.tail)       s.tails.add(f.tail);
      if (f.batch)      s.batches.add(f.batch);
    });
    const scheduledOutcome = s.completed + s.canceled;
    s.completionRate = scheduledOutcome > 0 ? (s.completed / scheduledOutcome) * 100 : null;
    return s;
  }, [flights]);

  // Hourly schedule pulse (06–21)
  const hourly = useM_d(() => {
    const HOURS = [];
    for (let h = 6; h <= 21; h++) HOURS.push(h);
    const buckets = Object.fromEntries(HOURS.map(h => [h, { total: 0, completed: 0, ap127: 0 }]));
    flights.forEach(f => {
      const m = minutesOf(f.start); if (m == null) return;
      const h = Math.floor(m / 60);
      if (!buckets[h]) return;
      buckets[h].total++;
      if (f.status === 'Completed') buckets[h].completed++;
      if (f.batch === HIGHLIGHT_BATCH) buckets[h].ap127++;
    });
    const max = Math.max(1, ...HOURS.map(h => buckets[h].total));
    return { HOURS, buckets, max };
  }, [flights]);

  // Batch breakdown (exclude MEETING and non-training entries)
  const byBatch = useM_d(() => {
    const m = {};
    flights.forEach(f => {
      const b = f.batch || '—';
      if (/meeting|recurrent/i.test(b) || /meeting/i.test(f.lesson || '')) return;
      if (!m[b]) m[b] = { name: b, total: 0, pending: 0, completed: 0, canceled: 0, standby: 0, hours: 0 };
      m[b].total++;
      if (f.status === 'Pending')   m[b].pending++;
      if (f.status === 'Completed') m[b].completed++;
      if (f.status === 'Canceled')  m[b].canceled++;
      if (f.isStandby) m[b].standby++;
      m[b].hours += (f.durMin || 0) / 60;
    });
    return Object.values(m).sort((a, b) => {
      // AP-127 always first if present
      if (a.name === HIGHLIGHT_BATCH) return -1;
      if (b.name === HIGHLIGHT_BATCH) return 1;
      return b.total - a.total;
    });
  }, [flights]);

  // Top instructors (by hours), with completion %
  const byInstructor = useM_d(() => {
    const m = {};
    flights.forEach(f => {
      if (!f.instructor) return;
      const k = f.instructor;
      if (!m[k]) m[k] = { name: k, total: 0, completed: 0, canceled: 0, hours: 0, ap127: 0 };
      m[k].total++;
      if (f.status === 'Completed') m[k].completed++;
      if (f.status === 'Canceled')  m[k].canceled++;
      m[k].hours += (f.durMin || 0) / 60;
      if (f.batch === HIGHLIGHT_BATCH) m[k].ap127++;
    });
    return Object.values(m).sort((a, b) => b.hours - a.hours || b.total - a.total);
  }, [flights]);

  // Aircraft fleet usage (by tail)
  const byTail = useM_d(() => {
    const m = {};
    flights.forEach(f => {
      if (f.isSim) return;
      if (!f.tail) return;  // Skip unassigned aircraft
      const k = f.tail;
      if (!m[k]) m[k] = { name: k, type: f.type || '—', total: 0, completed: 0, canceled: 0, hours: 0 };
      m[k].total++;
      if (f.status === 'Completed') m[k].completed++;
      if (f.status === 'Canceled')  m[k].canceled++;
      m[k].hours += (f.durMin || 0) / 60;
    });
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [flights]);

  // AP-127 specific
  const ap127 = useM_d(() => {
    const arr = flights.filter(f => f.batch === HIGHLIGHT_BATCH);
    const s = {
      flights: arr.length, students: new Set(), instructors: new Set(),
      completed: 0, pending: 0, canceled: 0, standby: 0, sim: 0,
      hours: 0, completedHours: 0, pendingHours: 0, canceledHours: 0,
      lessons: new Set(),
    };
    arr.forEach(f => {
      if (f.student)    s.students.add(f.student);
      if (f.instructor) s.instructors.add(f.instructor);
      if (f.lesson)     s.lessons.add(f.lesson);
      if (f.status === 'Pending')   { s.pending++; s.pendingHours += (f.durMin||0)/60; }
      if (f.status === 'Completed') { s.completed++; const m = f.airborne ? hmToMin_d(f.airborne) : (f.durMin||0); s.completedHours += m/60; }
      if (f.status === 'Canceled')  { s.canceled++; s.canceledHours += (f.durMin||0)/60; }
      if (f.isStandby) s.standby++;
      if (f.isSim)     s.sim++;
      s.hours += (f.durMin || 0) / 60;
    });
    const outcome = s.completed + s.canceled;
    s.completionRate = outcome > 0 ? (s.completed / outcome) * 100 : null;
    // Sort flights by start time
    const sorted = [...arr].sort((a, b) => (minutesOf(a.start) || 0) - (minutesOf(b.start) || 0));
    return { ...s, list: sorted };
  }, [flights]);

  // Compare AP-127 completion rate vs school
  const schoolRate = stats.completionRate;
  const apRate     = ap127.completionRate;

  // Leave & maintenance status for the selected date
  const leaveMap = useM_d(() => leavesOnDate(date), [date]);

  // Status mix slices for donut — mutually exclusive (SIM excluded)
  const statusSlices = [
    { label: 'Completed', value: stats.mix.completed, color: 'var(--col-done)' },
    { label: 'Pending',   value: stats.mix.pending,   color: 'var(--col-pending)' },
    { label: 'Standby',   value: stats.mix.standby,   color: 'var(--col-stby)' },
    { label: 'Canceled',  value: stats.mix.canceled,  color: 'var(--col-cancel)' },
  ].filter(s => s.value > 0);

  const gridCols = isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))';

  return (
    <ArtboardShell style={{ display: 'flex', flexDirection: 'column' }}>
      <ThemeStyle/>

      {/* Top bar */}
      <div style={{
        minHeight: 38, padding: '0 16px', borderBottom: '1px solid var(--line)',
        background: 'var(--bg-2)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--col-done)', boxShadow: '0 0 8px var(--col-done)', animation: 'pulse 2s ease-in-out infinite' }}/>
          <ViewIcon id="daily" size={12} color="var(--ink-2)"/>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div className="mono uc" style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', letterSpacing: '0.08em' }}>AP127 COMMAND CENTER</div>
            <div className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>DAY AT A GLANCE</div>
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <div className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>{flights.length} FLTS · {FLIGHTS.length} TOTAL</div>
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ padding: isMobile ? '8px' : '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Date hero — click to open calendar picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <DateCalendarTrigger/>
            {isCurrentDay && (
              <span className="mono uc" style={{ fontSize:9, color:'var(--col-pending)', padding:'2px 7px', border:'1px solid var(--col-pending)', borderRadius:3 }}>TODAY</span>
            )}
          </div>

          {/* Hero KPI strip — School performance */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <DKPI label="TOTAL"     value={stats.total}        sub={`${hoursFmt(stats.schedHours)} HRS SCHED`} color="var(--col-pending)" small={isMobile}/>
            <DKPI label="COMPLETED" value={stats.completed}    sub={stats.completionRate != null ? `${stats.completionRate.toFixed(0)}% · ${hoursFmt(stats.flownHours)}H` : `${hoursFmt(stats.flownHours)}H`} color="var(--col-done)" small={isMobile}/>
            <DKPI label="PENDING"   value={stats.pending}      sub={`${stats.standby} STBY · ${hoursFmt(stats.pendingHours)}H`} color="var(--col-pending)" small={isMobile}/>
            <DKPI label="CANCELED"  value={stats.canceled}     sub={`${hoursFmt(stats.canceledHours)} HRS`} color="var(--col-cancel)" small={isMobile}/>
            <DKPI label="HOURS"     value={hoursFmt(stats.flownHours)} sub={`${hoursFmt(stats.schedHours)} PLAN`} color="var(--col-done)" small={isMobile}/>
            <DKPI label="SIM"       value={stats.sim}          sub={`${hoursFmt(stats.simHours)} HRS`} color="var(--col-sim)" small={isMobile}/>
            <DKPI label="A/C USED"  value={stats.tails.size}   sub="AIRCRAFT" color="var(--ink-2)" small={isMobile}/>
            <DKPI label="INSTR"     value={stats.instructors.size} sub="ACTIVE" color="var(--ink-2)" small={isMobile}/>
            <DKPI label="◆ AP-127"  value={stats.ap127}        sub={`${ap127.students.size} STUDENTS`} color="var(--highlight)" small={isMobile}/>
          </div>

          {/* Charts row — Schedule Pulse + Batch Breakdown side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
            {/* Schedule Pulse — smoothed line graph with filled areas (6–18) */}
            <Section title="SCHEDULE PULSE" hint="FLIGHTS BY START HOUR (06–18)">
              {flights.length === 0 ? (
                <div className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)', padding: '32px 0', textAlign: 'center' }}>NO FLIGHTS</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(() => {
                    // Hourly breakdown for 6–18 only
                    const hrs = [];
                    for (let h = 6; h <= 18; h++) hrs.push(h);
                    const buckets = Object.fromEntries(hrs.map(h => [h, { total: 0, ap127: 0, ap126: 0, ap124: 0, ap128: 0, ap129: 0 }]));
                    flights.forEach(f => {
                      const m = minutesOf(f.start);
                      if (m == null) return;
                      const h = Math.floor(m / 60);
                      if (!buckets[h]) return;
                      buckets[h].total++;
                      if (f.batch === 'AP-127') buckets[h].ap127++;
                      else if (f.batch === 'AP-126') buckets[h].ap126++;
                      else if (f.batch === 'AP-124') buckets[h].ap124++;
                      else if (f.batch === 'AP-128') buckets[h].ap128++;
                      else if (f.batch === 'AP-129') buckets[h].ap129++;
                    });

                    // Get max for scaling
                    const maxVal = Math.max(1, ...hrs.map(h => buckets[h].total));

                    // Catmull-Rom spline interpolation for smooth curves
                    const catmullRom = (p0, p1, p2, p3, t) => {
                      const t2 = t * t, t3 = t2 * t;
                      return 0.5 * (
                        2 * p1 +
                        (-p0 + p2) * t +
                        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
                      );
                    };

                    // Generate smooth path using Catmull-Rom
                    const genPath = (vals, w = 280, h = 100) => {
                      const pts = vals;
                      const px = w / (pts.length - 1), py = h / maxVal;

                      let path = `M 0 ${h}`;

                      // Draw curve through all points with Catmull-Rom spline
                      for (let i = 0; i < pts.length - 1; i++) {
                        const p0 = i === 0 ? pts[0] : pts[i - 1];
                        const p1 = pts[i];
                        const p2 = pts[i + 1];
                        const p3 = i === pts.length - 2 ? pts[pts.length - 1] : pts[i + 2];

                        for (let t = 0; t <= 1; t += 0.25) {
                          const y = catmullRom(p0, p1, p2, p3, t);
                          const x = (i + t) * px;
                          path += ` L ${x} ${h - y * py}`;
                        }
                      }
                      path += ` L ${w} ${h} Z`;
                      return path;
                    };

                    const totalPts = hrs.map(h => buckets[h].total);
                    const ap127Pts = hrs.map(h => buckets[h].ap127);
                    const ap126Pts = hrs.map(h => buckets[h].ap126);
                    const ap124Pts = hrs.map(h => buckets[h].ap124);
                    const ap128Pts = hrs.map(h => buckets[h].ap128);
                    const ap129Pts = hrs.map(h => buckets[h].ap129);
                    const W = 300, H = 80;

                    const FL_GREEN = 'oklch(0.88 0.30 130)';
                    return (
                      <>
                        <div style={{ background: 'color-mix(in oklch,var(--ink) 3%,transparent)', borderRadius: 6, padding: '4px 0 2px' }}>
                          <svg width="100%" height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ display: 'block' }} overflow="visible">
                            {/* Horizontal axis line — grey */}
                            <line x1="0" y1={H} x2={W} y2={H} stroke="var(--ink-3)" strokeWidth="0.8" opacity="0.6" />
                            {/* Vertical grid lines */}
                            {hrs.map((h, i) => (
                              <line key={`vg-${h}`} x1={i * W / 12} y1="0" x2={i * W / 12} y2={H} stroke="var(--line-soft)" strokeWidth="0.4" opacity="0.5" />
                            ))}
                            {/* Filled areas */}
                            <path d={genPath(ap124Pts, W, H)} fill="var(--batch-ap124)" opacity="0.40" />
                            <path d={genPath(ap126Pts, W, H)} fill="var(--batch-ap126)" opacity="0.40" />
                            <path d={genPath(ap128Pts, W, H)} fill="var(--batch-ap128)" opacity="0.40" />
                            <path d={genPath(ap129Pts, W, H)} fill="var(--batch-ap129)" opacity="0.40" />
                            <path d={genPath(ap127Pts, W, H)} fill="var(--batch-ap127)" opacity="0.45" />
                            {/* Total line — fluorescent green */}
                            <path d={genPath(totalPts, W, H)} fill="none" stroke={FL_GREEN} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            {/* Every-hour axis labels */}
                            {hrs.map((h, i) => (
                              <text key={`hr-${h}`} x={i * W / 12} y={H + 13} fontSize="7.5"
                                textAnchor={i === 0 ? 'start' : i === hrs.length - 1 ? 'end' : 'middle'}
                                fill="var(--ink-3)">{h}</text>
                            ))}
                          </svg>
                        </div>
                        <div style={{ display: 'flex', gap: 10, fontSize: 9, flexWrap: 'wrap' }}>
                          <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--batch-ap127)', borderRadius: 2, marginRight: 3 }} />AP-127</span>
                          <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--batch-ap126)', borderRadius: 2, marginRight: 3 }} />AP-126</span>
                          <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--batch-ap124)', borderRadius: 2, marginRight: 3 }} />AP-124</span>
                          <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--batch-ap128)', borderRadius: 2, marginRight: 3 }} />AP-128</span>
                          <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--batch-ap129)', borderRadius: 2, marginRight: 3 }} />AP-129</span>
                          <span style={{ marginLeft: 'auto' }}><span style={{ display: 'inline-block', width: 12, height: 2, background: FL_GREEN, marginRight: 3, verticalAlign: 'middle' }} />TOTAL</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </Section>

            {/* Batch breakdown — grouped bar chart: AP / HP / Other */}
            <Section title="BATCH BREAKDOWN" hint={`${byBatch.length} BATCH${byBatch.length === 1 ? '' : 'ES'} FLYING`}>
              {byBatch.length === 0 ? (
                <div className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)', padding: '8px 0' }}>NO DATA</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(() => {
                    const max = Math.max(...byBatch.map(b => b.total), 1);
                    const batchColor = n => {
                      if (n === 'AP-127') return 'var(--batch-ap127)';
                      if (n === 'AP-126') return 'var(--batch-ap126)';
                      if (n === 'AP-124') return 'var(--batch-ap124)';
                      if (n === 'AP-128') return 'var(--batch-ap128)';
                      if (n === 'AP-129') return 'var(--batch-ap129)';
                      if (/^HP/i.test(n))  return 'var(--col-stby)';
                      return 'var(--ink-3)';
                    };
                    const groups = [
                      { label: 'AP', items: byBatch.filter(b => /^AP-/i.test(b.name)) },
                      { label: 'HP', items: byBatch.filter(b => /^HP/i.test(b.name)) },
                      { label: 'OTHER', items: byBatch.filter(b => !/^AP-|^HP/i.test(b.name)) },
                    ].filter(g => g.items.length > 0);
                    return groups.map(g => (
                      <div key={g.label}>
                        <div className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', margin: '6px 0 4px', letterSpacing: '0.08em' }}>{g.label}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {g.items.map(b => {
                            const isHL = b.name === HIGHLIGHT_BATCH;
                            const color = batchColor(b.name);
                            return (
                              <div key={b.name} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <div className="mono uc" style={{
                                  width: 64, fontSize: 10, flexShrink: 0,
                                  color: color, fontWeight: isHL ? 700 : 500,
                                }}>{isHL ? '◆ ' : ''}{b.name}</div>
                                <div style={{ flex: 1, height: 14, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}>
                                  <div style={{ width: `${(b.total / max) * 100}%`, height: '100%', background: color, opacity: 0.85, transition: 'width .25s' }}/>
                                </div>
                                <div className="mono num" style={{ width: 24, fontSize: 11, color: 'var(--ink)', textAlign: 'right', fontWeight: 600 }}>{b.total}</div>
                                <div className="mono num" style={{ width: 44, fontSize: 9, color: 'var(--ink-3)', textAlign: 'right' }}>{hoursFmt(b.hours)}h</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </Section>
          </div>

          {/* Status Mix — full row below the pulse+batch grid */}
          <Section title="STATUS MIX" hint="OUTCOME DISTRIBUTION">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
              <DailyDonut slices={statusSlices} size={isMobile ? 110 : 130}/>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 140 }}>
                {[
                  { label: 'COMPLETED', value: stats.mix.completed, color: 'var(--col-done)' },
                  { label: 'PENDING',   value: stats.mix.pending,   color: 'var(--col-pending)' },
                  { label: 'STANDBY',   value: stats.mix.standby,   color: 'var(--col-stby)' },
                  { label: 'CANCELED',  value: stats.mix.canceled,  color: 'var(--col-cancel)' },
                ].map(s => {
                  const pct = stats.total > 0 ? (s.value / stats.total) * 100 : 0;
                  return (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                      <span style={{ width: 10, height: 10, background: s.color, borderRadius: 2, flexShrink: 0 }}/>
                      <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-2)', flex: 1 }}>{s.label}</span>
                      <span className="mono num" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{s.value}</span>
                      <span className="mono num" style={{ fontSize: 9, color: 'var(--ink-3)', width: 36, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </Section>

          {/* Instructor + Aircraft grid */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12 }}>
            <Section title="INSTRUCTOR LOAD" hint={`${byInstructor.length} INSTRUCTOR${byInstructor.length === 1 ? '' : 'S'}`}>
              {byInstructor.length === 0 ? (
                <div className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)', padding: '8px 0' }}>NO DATA</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                  {(() => {
                    const maxH = Math.max(...byInstructor.map(i => i.hours), 0.01);
                    return byInstructor.slice(0, 12).map(i => {
                      const pct = (i.hours / 8) * 100;
                      const barColor = pct >= 100 ? 'var(--col-done)' : pct >= 75 ? 'var(--col-pending)' : pct >= 50 ? 'var(--col-cancel)' : 'var(--ink-3)';
                      return (
                        <div key={i.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
                          <div style={{ width: 110, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                            <span style={{ fontSize: 11, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.name}>{i.name}</span>
                            {leaveMap[i.name] && <LeaveBadge reason={leaveMap[i.name]}/>}
                          </div>
                          <div style={{ flex: 1, height: 12, background: 'var(--bg-2)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{
                              width: `${(i.hours / maxH) * 100}%`, height: '100%',
                              background: barColor, opacity: 0.85,
                            }}/>
                          </div>
                          <div className="mono num" style={{ width: 40, fontSize: 10, color: 'var(--ink)', textAlign: 'right', fontWeight: 600 }}>{hoursFmt(i.hours)}h</div>
                          <div className="mono num" style={{ width: 32, fontSize: 9, color: barColor, textAlign: 'right' }}>{pct.toFixed(0)}%</div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </Section>

            <Section title="AIRCRAFT FLEET" hint={`${byTail.length} TAIL${byTail.length === 1 ? '' : 'S'} (ex. SIM)`}>
              {byTail.length === 0 ? (
                <div className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)', padding: '8px 0' }}>NO DATA</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
                  {(() => {
                    const max = Math.max(...byTail.map(t => t.total), 1);
                    // Priority: DA40TDI first, DA40CS second, then alphabetical
                    const typePriority = t => t === 'DA40TDI' ? 0 : t === 'DA40CS' ? 1 : 2;
                    const sorted = [...byTail].sort((a, b) => {
                      const tp = typePriority(a.type) - typePriority(b.type);
                      if (tp !== 0) return tp;
                      return a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
                    });
                    // Assign a distinct color per type
                    const typeColors = {};
                    const palette = ['var(--batch-ap124)','var(--batch-ap126)','var(--batch-ap128)','var(--batch-ap129)','var(--col-cancel)','var(--col-stby)'];
                    let ci = 0;
                    sorted.forEach(t => { if (!typeColors[t.type]) typeColors[t.type] = palette[ci++ % palette.length]; });
                    // Group rows by type
                    const groups = [];
                    let lastType = null;
                    sorted.forEach(t => {
                      if (t.type !== lastType) { groups.push({ type: t.type, color: typeColors[t.type], items: [] }); lastType = t.type; }
                      groups[groups.length - 1].items.push(t);
                    });
                    return groups.map(g => (
                      <div key={g.type}>
                        <div className="mono uc" style={{ fontSize: 8, color: g.color, margin: '6px 0 3px', fontWeight: 600 }}>{g.type}</div>
                        {g.items.map(t => (
                          <div key={t.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginBottom: 4 }}>
                            <div style={{ width: 70, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span className="mono" style={{ fontSize: 10, color: isTailMaint(t.name) ? 'var(--col-cancel)' : 'var(--ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                              {isTailMaint(t.name) && <GndBadge/>}
                            </div>
                            <div style={{ flex: 1, height: 12, background: 'var(--bg-2)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${(t.total / max) * 100}%`, height: '100%', background: g.color, opacity: 0.85 }}/>
                            </div>
                            <div className="mono num" style={{ width: 22, fontSize: 11, color: 'var(--ink)', textAlign: 'right', fontWeight: 600 }}>{t.total}</div>
                            <div className="mono num" style={{ width: 38, fontSize: 9, color: 'var(--ink-3)', textAlign: 'right' }}>{hoursFmt(t.hours)}h</div>
                          </div>
                        ))}
                      </div>
                    ));
                  })()}
                </div>
              )}
            </Section>
          </div>

          {/* AP-127 Spotlight */}
          <Section title="◆ AP-127 SPOTLIGHT" hint="FOCUS COHORT — TODAY'S FLIGHTS" accent="var(--highlight)" fullWidth>
            {ap127.flights === 0 ? (
              <div className="mono uc" style={{ fontSize: 10, color: 'var(--ink-3)', padding: '20px 0', textAlign: 'center' }}>
                NO AP-127 FLIGHTS ON {String(day).padStart(2, '0')} {mo}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* AP-127 KPIs */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <DKPI label="FLIGHTS"    value={ap127.flights}           sub={`${ap127.lessons.size} LESS · ${hoursFmt(ap127.hours)}H`} color="var(--highlight)" small={isMobile}/>
                  <DKPI label="STUDENTS"   value={ap127.students.size}     sub="FLYING"     color="var(--highlight)" small={isMobile}/>
                  <DKPI label="INSTR"      value={ap127.instructors.size}  sub="ASSIGNED"   color="var(--highlight)" small={isMobile}/>
                  <DKPI label="COMPLETED"  value={ap127.completed}         sub={ap127.completionRate != null ? `${ap127.completionRate.toFixed(0)}% · ${hoursFmt(ap127.completedHours)}H` : `${hoursFmt(ap127.completedHours)}H`} color="var(--col-done)" small={isMobile}/>
                  <DKPI label="PENDING"    value={ap127.pending}           sub={`${ap127.standby} STBY · ${hoursFmt(ap127.pendingHours)}H`} color="var(--col-pending)" small={isMobile}/>
                  <DKPI label="CANCELED"   value={ap127.canceled}          sub={`${hoursFmt(ap127.canceledHours)} HRS`} color="var(--col-cancel)" small={isMobile}/>
                  <DKPI label="HOURS"      value={hoursFmt(ap127.hours)}   sub="PLANNED"    color="var(--highlight)" small={isMobile}/>
                </div>

                {/* AP-127 student list */}
                <div style={{ background: 'var(--bg-2)', borderRadius: 6, border: '1px solid var(--line-soft)', overflow: 'hidden' }}>
                  <div className="mono uc" style={{
                    display: 'grid',
                    gridTemplateColumns: isMobile ? '60px 1fr 70px 60px' : '60px 1.4fr 1.4fr 100px 70px 60px 90px',
                    gap: 8, padding: '6px 12px', fontSize: 9, color: 'var(--ink-3)',
                    borderBottom: '1px solid var(--line-soft)', background: 'var(--bg)',
                  }}>
                    <span>TIME</span>
                    <span>STUDENT</span>
                    {!isMobile && <span>INSTRUCTOR</span>}
                    <span>LESSON</span>
                    {!isMobile && <span>TAIL</span>}
                    <span>DUR</span>
                    <span>STATUS</span>
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                    {ap127.list.map((f, i) => (
                      <div key={f.id + i}
                        onClick={() => app.setDrawer(f.id)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: isMobile ? '60px 1fr 70px 60px' : '60px 1.4fr 1.4fr 100px 70px 60px 90px',
                          gap: 8, padding: '6px 12px', fontSize: 11, alignItems: 'center',
                          borderBottom: '1px solid var(--line-soft)', cursor: 'pointer',
                          background: i % 2 ? 'transparent' : 'color-mix(in oklch,var(--ink) 1.5%,transparent)',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'color-mix(in oklch,var(--highlight) 8%,transparent)'}
                        onMouseLeave={e => e.currentTarget.style.background = i % 2 ? 'transparent' : 'color-mix(in oklch,var(--ink) 1.5%,transparent)'}>
                        <span className="mono num" style={{ fontWeight: 600, color: 'var(--ink)' }}>{f.start}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.student || '—'}</span>
                          {f.student && leaveMap[f.student] && <LeaveBadge reason={leaveMap[f.student]}/>}
                        </span>
                        {!isMobile && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', color: 'var(--ink-2)' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.instructor || '—'}</span>
                            {f.instructor && leaveMap[f.instructor] && <LeaveBadge reason={leaveMap[f.instructor]}/>}
                          </span>
                        )}
                        <span className="mono" style={{ color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.lesson}</span>
                        {!isMobile && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span className="mono" style={{ fontSize: 10, color: isTailMaint(f.tail) ? 'var(--col-cancel)' : 'var(--ink-2)', fontWeight: isTailMaint(f.tail) ? 600 : 400 }}>{f.tail || 'TBD'}</span>
                            {isTailMaint(f.tail) && <GndBadge/>}
                          </span>
                        )}
                        <span className="mono num" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{f.duration || ''}</span>
                        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <StatusPill status={f.status}/>
                          {f.isStandby && <StandbyTag/>}
                          {f.isSim && <Tag color="var(--col-sim)">SIM</Tag>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Lessons being flown today */}
                {ap127.lessons.size > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>LESSONS IN PROGRESS TODAY</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {[...ap127.lessons].sort().map(l => (
                        <span key={l} className="mono uc" style={{
                          padding: '3px 8px', fontSize: 9, borderRadius: 3,
                          background: 'color-mix(in oklch,var(--highlight) 12%,var(--surface))',
                          border: '1px solid color-mix(in oklch,var(--highlight) 35%,transparent)',
                          color: 'var(--highlight)', fontWeight: 600,
                        }}>{l}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Section>

          <div style={{ height: 8 }}/>
        </div>
      </div>

      <Drawer/>
    </ArtboardShell>
  );
}

window.DailyBoard = DailyBoard;
