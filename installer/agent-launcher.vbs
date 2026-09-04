' agent-launcher.vbs — starts the FreeAudit portal agent with no console window.
'
' The agent polls the FLSS portal for queued audits and runs them on this PC.
' Every install runs its own agent under its own Fullbay login, so an audit
' queued from the portal is picked up by whichever machine is switched on — it
' does not depend on any one person's computer.
'
' A startup shortcut points here, so the agent comes back after a reboot.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' Without agent-credentials.json the agent exits immediately; skip it quietly
' rather than leaving a failed process behind at every login.
If Not fso.FileExists(dir & "\agent-credentials.json") Then
  WScript.Quit 0
End If

sh.CurrentDirectory = dir
sh.Run """" & dir & "\node.exe"" agent.js", 0, False
