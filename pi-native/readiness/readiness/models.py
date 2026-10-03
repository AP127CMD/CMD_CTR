"""Plain data passed between the readiness modules. No behaviour beyond tiny derived flags."""
from __future__ import annotations

from dataclasses import dataclass, field

HARD_KINDS = ("long", "quality")


@dataclass(frozen=True)
class Workout:
    uuid: str
    date: str                 # YYYY-MM-DD
    title: str
    kind: str                 # long | quality | easy | rest | other
    dist_m: int | None = None
    dur_s: int | None = None
    applyable: bool = False   # True only for plain scheduled workouts, never Garmin Coach adaptive ones
    sched_id: str | None = None
    workout_id: str | None = None

    @property
    def hard(self) -> bool:
        return self.kind in HARD_KINDS

    @property
    def label(self) -> str:
        return self.title + (f" {round(self.dist_m / 1000)} km" if self.dist_m else "")


@dataclass(frozen=True)
class Signals:
    sleep: int | None
    bb: int | None
    tr: int | None
    hrv: str | None           # Garmin HRV status: BALANCED / UNBALANCED / LOW / POOR
    rhr: int | None


@dataclass(frozen=True)
class Flight:
    id: str
    date: str
    off: str                  # HH:MM — actual block-off if flown, else planned start; "" if unknown
    on: str                   # HH:MM — actual block-on if flown, else planned end; "" if unknown
    lesson: str
    cond: str
    instructor: str
    tail: str
    route: str
    ftype: str
    status: str               # feed status: Pending / Completed / Canceled ...
    is_sim: bool
    is_standby: bool
    cancel_reason: str = ""

    @property
    def cancelled(self) -> bool:
        return self.status == "Canceled"

    @property
    def aircraft(self) -> bool:
        """Counts for R1-R3: a real, not-cancelled aircraft booking (standby counts, SIM doesn't — R5)."""
        return not self.is_sim and not self.cancelled and bool(self.off)


@dataclass(frozen=True)
class Move:
    id: str
    workout: Workout
    frm: str
    to: str
    rule: str
    why: str


@dataclass(frozen=True)
class Verdict:
    s: str                    # GO | CAUTION | REVIEW
    why: str
    partial: bool


@dataclass(frozen=True)
class RunAdvice:
    plan: str
    advice: str
    rule: str


@dataclass
class Plan:
    today: str
    verdict: Verdict
    signals: Signals
    run: RunAdvice
    moves: list[Move] = field(default_factory=list)
    notes: dict[str, str] = field(default_factory=dict)   # date -> week-view tag, e.g. "> Wed (R1)"
