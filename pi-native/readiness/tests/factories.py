from readiness.models import Flight, Workout


def wk(date, title="Base", kind="easy", uuid=None, dist_m=None, applyable=False, sched_id=None, workout_id=None):
    return Workout(uuid=uuid or f"u-{date}-{title}", date=date, title=title, kind=kind, dist_m=dist_m,
                   applyable=applyable, sched_id=sched_id, workout_id=workout_id)


def fl(date, off, on, lesson="CSPGL 51", cond="SPIC", status="Pending", is_sim=False, fid=None, ftype="",
       tail="HS-TVG", is_standby=False, cancel_reason=""):
    return Flight(id=fid or f"BK-{date}-{off}", date=date, off=off, on=on, lesson=lesson, cond=cond,
                  instructor="PHAHOLYUTH P.", tail=tail, route="", ftype=ftype, status=status,
                  is_sim=is_sim, is_standby=is_standby, cancel_reason=cancel_reason)
