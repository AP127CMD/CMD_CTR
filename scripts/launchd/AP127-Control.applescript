-- AP127 Auto-Fetch Control — a small button-based GUI over scripts/launchd/manage.sh.
-- Compiled into a double-clickable .app (see install instructions) so it opens
-- straight into a dialog, no Terminal window.

set manageScript to "/Users/nugui/flight-schedule-feed/scripts/launchd/manage.sh"

set chromiumLoaded to (do shell script "launchctl list com.ap127.chromium >/dev/null 2>&1 && echo yes || echo no")
set fetchLoaded to (do shell script "launchctl list com.ap127.fetch >/dev/null 2>&1 && echo yes || echo no")

if fetchLoaded is "yes" then
	set statusText to "✅ Auto-fetch is RUNNING — checking every 5 minutes."
	set primaryBtn to "Pause"
	set secondaryBtn to "Stop"
else if chromiumLoaded is "yes" then
	set statusText to "⏸ Auto-fetch is PAUSED. Chrome is still running and signed in — resuming is instant."
	set primaryBtn to "Resume"
	set secondaryBtn to "Stop"
else
	set statusText to "⏹ Auto-fetch is OFF."
	set primaryBtn to "Start"
	set secondaryBtn to "Status"
end if

set dlgResult to button returned of (display dialog statusText & return & return & "What would you like to do?" ¬
	buttons {"Cancel", secondaryBtn, primaryBtn} ¬
	default button primaryBtn ¬
	with title "AP127 Auto-Fetch" ¬
	with icon note)

if dlgResult is "Cancel" then
	return
end if

if dlgResult is "Start" then
	set cmdName to "start"
else if dlgResult is "Pause" then
	set cmdName to "pause"
else if dlgResult is "Resume" then
	set cmdName to "resume"
else if dlgResult is "Stop" then
	set cmdName to "stop"
else if dlgResult is "Status" then
	set cmdName to "status"
end if

set output to do shell script manageScript & " " & cmdName & " 2>&1"

display dialog output with title "AP127 — " & dlgResult buttons {"OK"} default button "OK" with icon note
