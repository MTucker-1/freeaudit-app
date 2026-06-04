' freeaudit-launcher.vbs — runs the FreeAudit launcher fully hidden (no console
' window flash). The desktop/Start-menu shortcut points here.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\freeaudit.ps1""", 0, False
