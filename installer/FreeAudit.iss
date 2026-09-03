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
Source: "app\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userdesktop}\FreeAudit"; Filename: "{win}\System32\wscript.exe"; Parameters: """{app}\freeaudit-launcher.vbs"""; WorkingDir: "{app}"
Name: "{userprograms}\FreeAudit\FreeAudit"; Filename: "{win}\System32\wscript.exe"; Parameters: """{app}\freeaudit-launcher.vbs"""; WorkingDir: "{app}"
Name: "{userprograms}\FreeAudit\Stop FreeAudit"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\stop-freeaudit.ps1"""; WorkingDir: "{app}"

[Run]
Filename: "{win}\System32\wscript.exe"; Parameters: """{app}\freeaudit-launcher.vbs"""; Description: "Launch FreeAudit now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\stop-freeaudit.ps1"""; Flags: runhidden; RunOnceId: "stopfa"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
