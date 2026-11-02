' scheduled-launcher.vbs — runs a scheduled FreeAudit audit with no console window.
'
' Windows Task Scheduler calls this. The task runs as the logged-on user (the
' audit opens a real Chrome window, so it needs an interactive session), and
' running node.exe directly would leave a black console window sitting on screen
' for the whole audit. Launching through wscript keeps it out of the way.
'
' One argument: audit | open | both
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

kind = "audit"
If WScript.Arguments.Count > 0 Then kind = WScript.Arguments(0)

' In an install, node.exe and run-scheduled.js sit in the same folder as this
' script. In a source checkout this script lives one level down in installer\,
' so look up a level too before falling back to node on PATH.
app = here
If Not fso.FileExists(app & "\run-scheduled.js") Then
  parent = fso.GetParentFolderName(here)
  If fso.FileExists(parent & "\run-scheduled.js") Then app = parent
End If

If Not fso.FileExists(app & "\run-scheduled.js") Then WScript.Quit 1

' Self-update first. A PC that runs its audits on a schedule, and whose owner
' rarely clicks the desktop icon, would otherwise sit on old code indefinitely:
' the interactive launcher and the login launcher both call update.ps1 and this
' path did not, so scheduled audits silently ran whatever code was installed
' months ago. Fail-safe like every other caller - update.ps1 keeps the current
' version on any problem, so a bad download can never stop a scheduled audit.
upd = app & "\update.ps1"
If fso.FileExists(upd) Then
  On Error Resume Next
  sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & upd & """ -Dir """ & app & """", 0, True
  On Error GoTo 0
End If

node = app & "\node.exe"
If Not fso.FileExists(node) Then node = "node"

sh.CurrentDirectory = app
' True = wait for it to finish, so Task Scheduler's "last run result" and its
' running/idle state reflect the actual audit rather than the launcher.
sh.Run """" & node & """ """ & app & "\run-scheduled.js"" " & kind, 0, True
