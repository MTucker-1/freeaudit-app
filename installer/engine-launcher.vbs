' engine-launcher.vbs — starts the FreeAudit engine at login, with no window.
'
' A Startup shortcut points here. Without it only the portal agent came back
' after a reboot, and the web app stayed down until someone clicked the desktop
' icon — so "open FreeAudit" failed on a freshly restarted PC.
'
' -EngineOnly starts the server but does NOT open the app window: nobody wants a
' browser appearing at every login. The desktop icon still opens the window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' Without a Fullbay login saved there is nothing useful to serve yet; the first
' run of the desktop icon walks the person through setup instead.
If Not fso.FileExists(dir & "\freeaudit.ps1") Then
  WScript.Quit 0
End If

sh.CurrentDirectory = dir
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\freeaudit.ps1"" -EngineOnly", 0, False
