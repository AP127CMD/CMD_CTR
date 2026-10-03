import copy

from factories import fl, wk
from readiness import rules as R
from readiness.config import DEFAULT_RULES
from readiness.models import Signals

RULES = copy.deepcopy(DEFAULT_RULES)
GOOD = Signals(sleep=82, bb=64, tr=71, hrv="BALANCED", rhr=49)
TODAY = "2026-10-05"


# ---- verdict -------------------------------------------------------------------------------
def test_verdict_go_when_all_signals_good():
    v = R.verdict(GOOD, RULES)
    assert (v.s, v.partial) == ("GO", False)
    assert v.why == "sleep 82, BB 64, TR 71"


def test_verdict_caution_on_one_low_signal():
    assert R.verdict(Signals(55, 64, 71, None, None), RULES).s == "CAUTION"


def test_verdict_review_on_one_review_level_signal():
    assert R.verdict(Signals(82, 20, 71, None, None), RULES).s == "REVIEW"


def test_verdict_review_on_two_caution_signals():
    assert R.verdict(Signals(55, 35, 71, None, None), RULES).s == "REVIEW"


def test_verdict_partial_never_silently_go_on_missing_data():
    v = R.verdict(Signals(None, 64, None, None, None), RULES)
    assert (v.s, v.partial, v.why) == ("GO", True, "BB 64")
    assert R.verdict(Signals(None, None, None, None, None), RULES).s == "REVIEW"


# ---- R1 --------------------------------------------------------------------------------------
def test_r1_quality_before_evening_flight_moves_to_next_free_day():
    ws = [wk("2026-10-06", "Tempo", "quality"), wk("2026-10-07", "Base"), wk("2026-10-10", "Long Run", "long")]
    flights = [fl("2026-10-06", "18:10", "19:10")]
    plan = R.evaluate(TODAY, GOOD, ws, flights, None, RULES)
    [m] = plan.moves
    assert (m.workout.title, m.frm, m.to, m.rule) == ("Tempo", "2026-10-06", "2026-10-07", "R1")
    assert m.id.startswith("m-") and len(m.id) == 12
    assert plan.notes["2026-10-06"] == "> Wed (R1)"


def test_r1_ignores_a_flight_that_is_earlier_the_same_day():
    ws = [wk("2026-10-06", "Tempo", "quality")]
    assert R.evaluate(TODAY, GOOD, ws, [fl("2026-10-06", "09:30", "11:00")], None, RULES).moves == []


def test_r1_triggers_for_an_early_flight_next_morning():
    ws = [wk("2026-10-06", "Tempo", "quality")]
    assert R.conflict("quality", "2026-10-06", [fl("2026-10-07", "04:30", "06:00")], RULES)[0] == "R1"


# ---- R2 --------------------------------------------------------------------------------------
def test_r2_long_run_before_demanding_flight_moves_after_it():
    ws = [wk("2026-10-06", "Tempo", "quality"), wk("2026-10-10", "Long Run", "long", dist_m=25010)]
    flights = [fl("2026-10-11", "08:00", "10:30", lesson="CSPXC 50", cond="XC")]
    [m] = R.evaluate(TODAY, GOOD, ws, flights, None, RULES).moves
    assert (m.to, m.rule) == ("2026-10-11", "R2")


def test_r2_ignores_a_routine_dual_lesson():
    ws = [wk("2026-10-10", "Long Run", "long")]
    flights = [fl("2026-10-11", "08:00", "10:30", lesson="CSPGL 51", cond="SPIC")]
    assert R.evaluate(TODAY, GOOD, ws, flights, None, RULES).moves == []


# ---- R3 --------------------------------------------------------------------------------------
def test_r3_quality_after_late_night_flight_moves_a_day():
    ws = [wk("2026-10-06", "Intervals", "quality"), wk("2026-10-10", "Long Run", "long")]
    flights = [fl("2026-10-05", "20:00", "21:30", cond="XC / Night")]
    [m] = R.evaluate(TODAY, GOOD, ws, flights, None, RULES).moves
    assert (m.frm, m.to, m.rule) == ("2026-10-06", "2026-10-07", "R3")


# ---- R4 --------------------------------------------------------------------------------------
def test_r4_low_readiness_downgrades_todays_quality():
    ws = [wk(TODAY, "Tempo", "quality")]
    run = R.evaluate(TODAY, Signals(80, 60, 25, "BALANCED", 50), ws, [], None, RULES).run
    assert (run.plan, run.advice, run.rule) == ("Tempo", "Downgrade to easy - low readiness", "R4")


def test_r4_unbalanced_hrv_also_counts_as_low():
    ws = [wk(TODAY, "Tempo", "quality")]
    assert R.evaluate(TODAY, Signals(80, 60, 70, "UNBALANCED", 50), ws, [], None, RULES).run.rule == "R4"


def test_r4_does_not_touch_long_runs():
    ws = [wk(TODAY, "Long Run", "long", dist_m=25010)]
    run = R.evaluate(TODAY, Signals(80, 60, 25, "LOW", 50), ws, [], None, RULES).run
    assert (run.plan, run.advice, run.rule) == ("Long Run 25 km", "As planned", "")


# ---- R5 + cancelled ----------------------------------------------------------------------------
def test_r5_sim_sessions_never_trigger_moves():
    ws = [wk("2026-10-06", "Tempo", "quality")]
    assert R.evaluate(TODAY, GOOD, ws, [fl("2026-10-06", "18:10", "19:10", is_sim=True)], None, RULES).moves == []


def test_cancelled_flights_are_ignored():
    ws = [wk("2026-10-06", "Tempo", "quality")]
    flights = [fl("2026-10-06", "18:10", "19:10", status="Canceled")]
    assert R.evaluate(TODAY, GOOD, ws, flights, None, RULES).moves == []


def test_standby_flights_count():
    ws = [wk("2026-10-06", "Tempo", "quality")]
    flights = [fl("2026-10-06", "18:10", "19:10", is_standby=True)]
    assert len(R.evaluate(TODAY, GOOD, ws, flights, None, RULES).moves) == 1


# ---- R6 ----------------------------------------------------------------------------------------
def test_r6_no_safe_slot_downgrades_without_a_move():
    ws = [wk("2026-10-05", "Intervals", "quality"), wk("2026-10-07", "Tempo", "quality"),
          wk("2026-10-09", "Intervals", "quality"), wk("2026-10-11", "Long Run", "long")]
    plan = R.evaluate(TODAY, GOOD, ws, [fl("2026-10-07", "18:00", "19:00")], None, RULES)
    assert plan.moves == []
    assert plan.notes["2026-10-07"] == "easy (R1)"


def test_r6_moves_never_leave_the_week_or_go_before_today():
    w = wk("2026-10-05", "Tempo", "quality")
    slot = R.find_slot(w, [w], [fl("2026-10-05", "18:00", "19:00")], TODAY, None, RULES)
    assert slot == "2026-10-06"
    sunday = wk("2026-10-11", "Tempo", "quality")
    others = [sunday, wk("2026-10-10", "Long Run", "long")]
    # today is Fri 10-09: Thu and earlier are in the past, Mon 10-12 is next week, Fri/Sat touch the long run
    assert R.find_slot(sunday, others, [fl("2026-10-11", "18:00", "19:00")], "2026-10-09", None, RULES) is None


def test_r6_long_run_inside_race_window_is_kept_not_dropped():
    today = "2026-10-26"
    ws = [wk("2026-10-26", "Intervals", "quality"), wk("2026-10-29", "Tempo", "quality"),
          wk("2026-10-31", "Long Run", "long"), wk("2026-11-02", "Intervals", "quality")]
    flights = [fl("2026-11-01", "08:00", "10:30", lesson="CSPXC 52", cond="XC")]
    plan = R.evaluate(today, GOOD, ws, flights, "2026-11-15", RULES)
    assert plan.moves == []
    assert plan.notes["2026-10-31"] == "keep (R2)"


def test_r6_never_moves_onto_or_past_race_day():
    w = wk("2026-11-14", "Tempo", "quality")
    assert R.find_slot(w, [w], [fl("2026-11-14", "18:00", "19:00")], "2026-11-09", "2026-11-15", RULES) == "2026-11-13"


# ---- ids, today, R7 ----------------------------------------------------------------------------
def test_move_id_is_stable_and_proposal_specific():
    w = wk("2026-10-06", "Tempo", "quality")
    assert R.move_id(w, "2026-10-06", "2026-10-07") == R.move_id(w, "2026-10-06", "2026-10-07")
    assert R.move_id(w, "2026-10-06", "2026-10-07") != R.move_id(w, "2026-10-06", "2026-10-08")


def test_rest_day_when_no_running_workout_today():
    ws = [wk(TODAY, "Total Body Circuit 1", "other")]
    assert R.evaluate(TODAY, GOOD, ws, [], None, RULES).run.plan == "Rest"


def test_todays_moved_workout_carries_the_move_advice():
    ws = [wk(TODAY, "Tempo", "quality", applyable=True)]
    run = R.evaluate(TODAY, GOOD, ws, [fl(TODAY, "18:10", "19:10")], None, RULES).run
    assert run.rule == "R1" and run.advice == "Move to Tue 10-06 - Apply on watch"


def test_r7_hint_when_the_flight_behind_an_applied_move_is_gone():
    applied = {"m-x": {"uuid": "u1", "frm": "2026-10-06", "to": "2026-10-07"}}
    ws = [wk("2026-10-07", "Tempo", "quality", uuid="u1")]
    assert R.move_back_hints(applied, ws, [], TODAY, RULES) == [
        "Tempo: flight gone - could move back to Tue 10-06 (R7)"]
    still = [fl("2026-10-06", "18:10", "19:10")]
    assert R.move_back_hints(applied, ws, still, TODAY, RULES) == []
