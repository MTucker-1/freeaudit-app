; FreeAudit installer — bundles the app, a portable Node, and the browser engine
; so a teammate can install with one double-click (no admin, no technical setup).
; Each install is that person's own copy: their own logins, runs on their own PC,
; and auto-updates its code from the central channel on launch.

#define AppName "FreeAudit"
; AppVer is passed in by build-installer.ps1 (/DAppVer=x.y.z) from version.json.
; The fallback only applies when compiling this script by hand.
#ifndef AppVer
  #define AppVer "0.0.0"
#endif

[Setup]
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=Freedom
DefaultDirName={localappdata}\Programs\FreeAudit
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=.
OutputBaseFilename=FreeAudit-Setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
UninstallDisplayName=FreeAudit

[Files]
; Application code and runtime — always replaced on install/upgrade.
; The per-user files are excluded here and re-added below, because copying them
; with ignoreversion would wipe somebody's saved Fullbay login and settings every
; time they reinstall or upgrade.
Source: "app\*"; DestDir: "{app}"; \
  Excludes: "config.json,fullbay-credentials.json,vorto-credentials.json,google-credentials.json,users.json,sessions.json"; \
  Flags: recursesubdirs createallsubdirs ignoreversion

; Per-user files: written ONLY on a first install. An upgrade leaves whatever the
; person already has. New settings still reach them — settings.js merges
; config.json over the shipped defaults at runtime.
Source: "app\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "app\fullbay-credentials.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "app\vorto-credentials.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "app\google-credentials.json"; DestDir: "{app}"; Flags: onlyifdoesntexist

[Icons]
Name: "{userdesktop}\FreeAudit"; Filename: "{win}\System32\wscript.exe"; Parameters: """{app}\freeaudit-launcher.vbs"""; WorkingDir: "{app}"
Name: "{userprograms}\FreeAudit\FreeAudit"; Filename: "{win}\System32\wscript.exe"; Parameters: """{app}\freeaudit-launcher.vbs"""; WorkingDir: "{app}"
Name: "{userprograms}\FreeAudit\Stop FreeAudit"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\stop-freeaudit.ps1"""; WorkingDir: "{app}"

[Run]
Filename: "{win}\System32\wscript.exe"; Parameters: """{app}\freeaudit-launcher.vbs"""; Description: "Launch FreeAudit now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\stop-freeaudit.ps1"""; Flags: runhidden; RunOnceId: "stopfa"

[UninstallDelete]
; Removes the whole folder, INCLUDING each person's saved credentials, accounts
; and browser session. That is the right behaviour for an uninstall — nobody
; wants their Fullbay session left on a machine they have finished with.
Type: filesandordirs; Name: "{app}"
