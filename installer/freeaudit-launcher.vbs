' freeaudit-launcher.vbs — runs the FreeAudit launcher fully hidden (no console
' window flash). The desktop/Start-menu shortcut points here.
'
' It WAITS for the launcher and reports a failure. Fire-and-forget meant that a
' blocked or crashed launcher (script policy, antivirus, a bug) looked exactly
' like "double-clicking the icon does nothing", with nothing to go on.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

On Error Resume Next
code = sh.Run("powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\freeaudit.ps1""", 0, True)
If Err.Number <> 0 Then
  MsgBox "FreeAudit could not start PowerShell on this PC:" & vbCrLf & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
    "Antivirus or a company policy may be blocking it. Send this message to your FreeAudit admin.", vbExclamation, "FreeAudit"
ElseIf code <> 0 Then
  MsgBox "FreeAudit's launcher stopped with an error (code " & code & ")." & vbCrLf & vbCrLf & _
    "A company policy may be blocking PowerShell scripts, or antivirus may be blocking FreeAudit. " & _
    "Try again, or restart the PC. If it keeps happening, send this message to your FreeAudit admin.", vbExclamation, "FreeAudit"
End If
