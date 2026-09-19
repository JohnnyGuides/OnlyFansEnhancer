#ifndef StageSource
  #error StageSource is required
#endif
#ifndef OutputRoot
  #define OutputRoot StageSource
#endif

[Setup]
AppId={{D4702E08-310F-477A-91DA-DC45603DD6AF}
AppName=OFEnhancer
AppVersion=0.20.26
DefaultDirName={localappdata}\Programs\OFEnhancer
DefaultGroupName=OFEnhancer
OutputDir={#OutputRoot}
OutputBaseFilename=OFEnhancer-Setup-0.20.26
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#StageSource}\assets\ofenhancer.ico
UninstallDisplayIcon={app}\desktop\OFEnhancer.Desktop.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Files]
Source: "{#StageSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\OFEnhancer"; Filename: "{app}\desktop\OFEnhancer.Desktop.exe"
Name: "{group}\Connect Chrome"; Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--chrome-setup"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OFEnhancer"; ValueData: """{app}\desktop\OFEnhancer.Desktop.exe"""; Flags: uninsdeletevalue

Root: HKCU; Subkey: "Software\Classes\ofenhancer"; ValueType: string; ValueData: "URL:OFEnhancer Chrome setup"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\ofenhancer"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\ofenhancer\shell\open\command"; ValueType: string; ValueData: """{app}\desktop\OFEnhancer.Desktop.exe"" --chrome-setup"

[Run]
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Description: "Start OFEnhancer"; Flags: postinstall nowait skipifsilent
Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--chrome-setup"; Description: "Check Chrome setup or reload guidance"; Flags: postinstall nowait skipifsilent unchecked

Filename: "{app}\desktop\OFEnhancer.Desktop.exe"; Parameters: "--chrome-setup"; Flags: nowait; Check: IsFreshReset

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\unregister-native-host.ps1"" -InstallRoot ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "UnregisterNativeHost"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\OFEnhancer"; Check: ShouldDeleteUserData

[Code]
var
  ExistingPage: TInputOptionWizardPage;
  KeepDataPage: TInputOptionWizardPage;
  ExistingUninstaller: String;
  ExistingUninstallCompleted: Boolean;
  RemoveUserData: Boolean;

function IsFreshReset(): Boolean;
begin
  Result := (ExistingPage <> nil) and (ExistingPage.SelectedValueIndex = 1);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if (CurStep = ssPostInstall) and IsFreshReset() then
    if not Exec(ExpandConstant('{app}\desktop\OFEnhancer.Desktop.exe'), '--mark-chrome-reset', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('Fresh reset could not be started. Open OFEnhancer and choose Fresh reset; Chrome has not been reset.');
end;

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
      'Both install options keep your catalogue, Google connection, settings and history. Fresh reinstall requires removing the old extension and reconnecting in Chrome.',
      True,
      False
    );
    ExistingPage.Add('Update or reinstall - keep Chrome extension and its state');
    ExistingPage.Add('Fresh reinstall - reset Chrome extension only');
    ExistingPage.Add('Uninstall');
    ExistingPage.SelectedValueIndex := 0;

    KeepDataPage := CreateInputOptionPage(
      ExistingPage.ID,
      'Keep your OFEnhancer data?',
      'Choose what should happen to your local data.',
      'Keeping it preserves your settings, catalogue, thumbnails, Google connection, and history for a future reinstall.',
      False,
      False
    );
    KeepDataPage.Add('Keep settings, catalogue, and history');
    KeepDataPage.Values[0] := True;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result :=
    (KeepDataPage <> nil) and
    (PageID = KeepDataPage.ID) and
    (ExistingPage.SelectedValueIndex <> 2);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if (KeepDataPage <> nil) and (CurPageID = KeepDataPage.ID) then
  begin
    if not Exec(
      '>',
      ExistingUninstaller + ' /SILENT /NORESTART',
      '',
      SW_SHOW,
      ewWaitUntilTerminated,
      ExitCode
    ) then
      MsgBox(
        'Windows could not start the existing uninstaller: ' + SysErrorMessage(ExitCode),
        mbError,
        MB_OK
      )
    else if ExitCode <> 0 then
      MsgBox(
        'OFEnhancer could not be uninstalled. Your data was not removed.',
        mbError,
        MB_OK
      )
    else
    begin
      if not KeepDataPage.Values[0] then
        if not DelTree(ExpandConstant('{localappdata}\OFEnhancer'), True, True, True) then
          MsgBox(
        'OFEnhancer was removed, but Windows could not remove all local data.',
            mbError,
            MB_OK
          );
      ExistingUninstallCompleted := True;
      WizardForm.Close;
    end;
    Result := False;
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if ExistingUninstallCompleted then
    Confirm := False;
end;

function ShouldDeleteUserData(): Boolean;
begin
  Result := RemoveUserData;
end;

procedure InitializeUninstallProgressForm();
var
  ButtonLabels: TArrayOfString;
begin
  if UninstallSilent then
    Exit;

  SetArrayLength(ButtonLabels, 2);
  ButtonLabels[0] :=
    'Keep my data (recommended)' + #13#10 +
    'Preserve settings, catalogue, thumbnails, Google connection, and history.';
  ButtonLabels[1] :=
    'Remove my data' + #13#10 +
    'Delete OFEnhancer data stored on this PC.';
  RemoveUserData := TaskDialogMsgBox(
    'Keep your OFEnhancer data?',
    'You can reinstall later without setting everything up again.',
    mbConfirmation,
    MB_YESNO,
    ButtonLabels,
    0
  ) = IDNO;
end;
