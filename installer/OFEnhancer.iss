#ifndef StageSource
  #error StageSource is required
#endif
#ifndef OutputRoot
  #define OutputRoot StageSource
#endif

[Setup]
AppId={{D4702E08-310F-477A-91DA-DC45603DD6AF}
AppName=OFEnhancer
AppVersion=0.20.1
DefaultDirName={localappdata}\Programs\OFEnhancer
DefaultGroupName=OFEnhancer
OutputDir={#OutputRoot}
OutputBaseFilename=OFEnhancer-Setup-0.20.1
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#StageSource}\assets\ofenhancer.ico
UninstallDisplayIcon={app}\desktop\OFEnhancer.Desktop.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#StageSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\OFEnhancer"; Filename: "{app}\desktop\OFEnhancer.Desktop.exe"
Name: "{group}\Connect Chrome"; Filename: "{app}\extension-setup.html"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OFEnhancer"; ValueData: """{app}\desktop\OFEnhancer.Desktop.exe"""; Flags: uninsdeletevalue

[Run]
#ifdef PersonalExtensionId
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\tools\register-native-host.ps1"" -InstallRoot ""{app}"" -ExtensionId ""{#PersonalExtensionId}"""; StatusMsg: "Connecting Chrome..."; Flags: runhidden waituntilterminated
#endif
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Description: "Start OFEnhancer"; Flags: postinstall nowait skipifsilent
#ifndef PersonalExtensionId
Filename: "{app}\extension-setup.html"; Description: "Connect the Chrome extension"; Flags: postinstall shellexec skipifsilent
#endif

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\unregister-native-host.ps1"" -InstallRoot ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterNativeHost"

[Code]
var
  ExistingPage: TInputOptionWizardPage;
  ExistingUninstaller: String;

function ExistingInstall(): Boolean;
begin
  Result := RegQueryStringValue(
    HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D4702E08-310F-477A-91DA-DC45603DD6AF}_is1',
    'UninstallString',
    ExistingUninstaller
  );
end;

procedure InitializeWizard();
begin
  if ExistingInstall() then
  begin
    ExistingPage := CreateInputOptionPage(
      wpWelcome,
      'OFEnhancer is already installed',
      'Choose what this installer should do.',
      '',
      True,
      False
    );
    ExistingPage.Add('Update or reinstall');
    ExistingPage.Add('Uninstall');
    ExistingPage.SelectedValueIndex := 0;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if (ExistingPage <> nil) and (CurPageID = ExistingPage.ID) and (ExistingPage.SelectedValueIndex = 1) then
  begin
    if not Exec(RemoveQuotes(ExistingUninstaller), '/SILENT', '', SW_SHOW, ewWaitUntilTerminated, ExitCode) then
      MsgBox('Windows could not start the existing uninstaller.', mbError, MB_OK);
    WizardForm.Close;
    Result := False;
  end;
end;
