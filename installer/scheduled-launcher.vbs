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

node = app & "\node.exe"
If Not fso.FileExists(node) Then node = "node"

sh.CurrentDirectory = app
' True = wait for it to finish, so Task Scheduler's "last run result" and its
' running/idle state reflect the actual audit rather than the launcher.
sh.Run """" & node & """ """ & app & "\run-scheduled.js"" " & kind, 0, True
