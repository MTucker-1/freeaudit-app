' freeaudit-launcher.vbs — runs the FreeAudit launcher fully hidden (no console
' window flash). The desktop/Start-menu shortcut points here.
'
' It WAITS for the launcher and reports a failure. Fire-and-forget meant that a
' blocked or crashed launcher (script policy, antivirus, a bug) looked exactly
' like "double-clicking the icon does nothing", with nothing to go on.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

script = dir & "\freeaudit.ps1"

' A MISSING launcher is its own failure and deserves its own message. PowerShell
' answers -196608 (0xFFFD0000) when it cannot open the -File it was given, and
' the old catch-all blamed "a company policy blocking PowerShell scripts" —
' which sent the first person who hit it looking for a policy that was never the
' problem. Antivirus quarantining this folder is the usual cause.
If Not fso.FileExists(script) Then
  MsgBox "FreeAudit is missing a file it needs to start:" & vbCrLf & vbCrLf & script & vbCrLf & vbCrLf & _
    "Antivirus has most likely quarantined it, or the install did not finish. " & _
    "Re-run FreeAudit-Setup.exe over the top — your logins and settings are kept. " & _
    "Do NOT uninstall first.", vbExclamation, "FreeAudit"
  WScript.Quit
End If

On Error Resume Next
code = sh.Run("powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, True)
If Err.Number <> 0 Then
  MsgBox "FreeAudit could not start PowerShell on this PC:" & vbCrLf & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
    "Antivirus or a company policy may be blocking it. Send this message to your FreeAudit admin.", vbExclamation, "FreeAudit"
ElseIf code = -196608 Then
  ' The file existed a moment ago, so something removed or locked it mid-launch.
  MsgBox "FreeAudit could not open its launcher file:" & vbCrLf & vbCrLf & script & vbCrLf & vbCrLf & _
    "Antivirus is most likely quarantining it as it runs. Allow the FreeAudit folder in your " & _
    "antivirus, then re-run FreeAudit-Setup.exe over the top — your logins and settings are kept.", vbExclamation, "FreeAudit"
ElseIf code <> 0 Then
  MsgBox "FreeAudit's launcher stopped with an error (code " & code & ")." & vbCrLf & vbCrLf & _
    "A company policy may be blocking PowerShell scripts, or antivirus may be blocking FreeAudit. " & _
    "Try again, or restart the PC. If it keeps happening, send this message to your FreeAudit admin.", vbExclamation, "FreeAudit"
End If
