#ifndef StageSource
  #error StageSource is required
#endif
#ifndef OutputRoot
  #define OutputRoot StageSource
#endif

[Setup]
AppId={{D4702E08-310F-477A-91DA-DC45603DD6AF}
AppName=OFEnhancer
AppVersion=0.20.30
DefaultDirName={localappdata}\Programs\OFEnhancer
DefaultGroupName=OFEnhancer
OutputDir={#OutputRoot}
OutputBaseFilename=OFEnhancer-Setup-0.20.30
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
; The new maintenance binary is embedded for pre-copy Fresh orchestration. It
; runs from {tmp}, never from the old install that Setup will remove.
Source: "{#StageSource}\desktop\*"; DestDir: "{tmp}\ofenhancer-maintenance\desktop"; Flags: dontcopy noencryption recursesubdirs createallsubdirs
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
  FreshPage: TWizardPage;
  FreshSummary: TNewStaticText;
  FreshSteps: TNewStaticText;
  FreshStatus: TNewStaticText;
  ExistingUninstaller: String;
  ExistingInstallRoot: String;
  ExistingUninstallCompleted: Boolean;
  RemoveUserData: Boolean;
  ResumeFresh: Boolean;
  FreshRemovalReady: Boolean;
  FreshManualRequired: Boolean;
  MaintenanceExtracted: Boolean;

function IsFreshReset(): Boolean;
begin
  Result := ResumeFresh or ((ExistingPage <> nil) and (ExistingPage.SelectedValueIndex = 1));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if (CurStep = ssPostInstall) and IsFreshReset() then
    if not Exec(
      ExpandConstant('{app}\desktop\OFEnhancer.Desktop.exe'),
      '--fresh-reinstall-installed --install-root "' + ExpandConstant('{app}') + '" --package-version 0.20.30',
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode
    ) or (ExitCode <> 0) then
      RaiseException('The clean package was copied, but its Fresh reinstall admission barrier could not be established. Run this installer again to resume.');
end;

function ExistingInstall(): Boolean;
begin
  Result := RegQueryStringValue(
    HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D4702E08-310F-477A-91DA-DC45603DD6AF}_is1',
    'UninstallString',
    ExistingUninstaller
  ) and RegQueryStringValue(
    HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{D4702E08-310F-477A-91DA-DC45603DD6AF}_is1',
    'InstallLocation',
    ExistingInstallRoot
  );
end;

procedure InitializeWizard();
var
  FreshAfterID: Integer;
begin
  ResumeFresh := FileExists(ExpandConstant('{localappdata}\OFEnhancer-Maintenance\fresh-reinstall.json'));
  if ExistingInstall() then
  begin
    ExistingPage := CreateInputOptionPage(
      wpWelcome,
      'OFEnhancer is already installed',
      'Choose what this installer should do.',
      'Update preserves your desktop and Chrome state. Fresh reinstall removes the previous extension, OFEnhancer desktop data and caches, and obsolete installed files before installing clean files.',
      True,
      False
    );
    ExistingPage.Add('Update or reinstall - keep Chrome extension and its state');
    ExistingPage.Add('Fresh reinstall - remove extension and all OFEnhancer desktop state');
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

  if ExistingPage <> nil then
    FreshAfterID := ExistingPage.ID
  else
    FreshAfterID := wpWelcome;
  FreshPage := CreateCustomPage(
    FreshAfterID,
    'Remove the previous Chrome extension',
    'Setup handles this before deleting OFEnhancer files or data.'
  );
  FreshSummary := TNewStaticText.Create(FreshPage.Surface);
  FreshSummary.Parent := FreshPage.Surface;
  FreshSummary.AutoSize := False;
  FreshSummary.WordWrap := True;
  FreshSummary.Font.Style := [fsBold];
  FreshSummary.SetBounds(0, 8, FreshPage.SurfaceWidth, 36);
  FreshSummary.Caption := 'Keep Chrome open. Setup will request removal automatically.';

  FreshSteps := TNewStaticText.Create(FreshPage.Surface);
  FreshSteps.Parent := FreshPage.Surface;
  FreshSteps.AutoSize := False;
  FreshSteps.WordWrap := True;
  FreshSteps.SetBounds(0, 56, FreshPage.SurfaceWidth, 122);
  FreshSteps.Caption :=
    '• Setup asks the existing extension to remove itself.' + #13#10 +
    '• If Chrome needs help, this page will show one Remove step.' + #13#10 +
    '• Reload is not removal.' + #13#10 +
    '• Nothing is deleted until Chrome removal is confirmed.';

  FreshStatus := TNewStaticText.Create(FreshPage.Surface);
  FreshStatus.Parent := FreshPage.Surface;
  FreshStatus.AutoSize := False;
  FreshStatus.WordWrap := True;
  FreshStatus.SetBounds(0, 194, FreshPage.SurfaceWidth, 72);
  FreshStatus.Caption := 'Ready to remove the previous extension.';
end;

function ValidExistingUninstaller(): Boolean;
var
  Candidate, RootPrefix: String;
begin
  Candidate := ExistingUninstaller;
  StringChangeEx(Candidate, '"', '', True);
  ExistingInstallRoot := RemoveBackslashUnlessRoot(ExpandFileName(ExistingInstallRoot));
  RootPrefix := AddBackslash(ExistingInstallRoot);
  Result :=
    (ExistingInstallRoot <> '') and
    (CompareText(ExistingInstallRoot, RemoveBackslashUnlessRoot(ExpandFileName(WizardDirValue))) = 0) and
    (Pos(Lowercase(RootPrefix), Lowercase(ExpandFileName(Candidate))) = 1) and
    (Pos('unins', Lowercase(ExtractFileName(Candidate))) = 1) and
    FileExists(Candidate);
end;

function RunFreshHelper(const Operation: String; var ExitCode: Integer): Boolean;
var
  Helper, Parameters: String;
begin
  Helper := ExpandConstant('{tmp}\ofenhancer-maintenance\desktop\OFEnhancer.Desktop.exe');
  Parameters := Operation +
    ' --install-root "' + ExpandConstant('{app}') + '"' +
    ' --package-version 0.20.30';
  Result := Exec(Helper, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
end;

function ExtractFreshMaintenance(): Boolean;
begin
  Result := True;
  if MaintenanceExtracted then Exit;
  try
    ExtractTemporaryFiles('{tmp}\ofenhancer-maintenance\desktop\*');
    MaintenanceExtracted := True;
  except
    Result := False;
  end;
end;

function RunChromeRemovalStep(): Boolean;
var
  ExitCode: Integer;
begin
  Result := False;
  WizardForm.NextButton.Enabled := False;
  FreshStatus.Font.Color := clWindowText;
  if FreshManualRequired then
    FreshStatus.Caption := 'Checking that the extension is gone…'
  else
    FreshStatus.Caption := 'Asking Chrome to remove the extension… This can take up to 20 seconds.';
  WizardForm.Refresh;

  if not ExtractFreshMaintenance() then
  begin
    FreshStatus.Font.Color := clRed;
    FreshStatus.Caption := 'Setup could not start Chrome cleanup. No files or data were changed.';
    WizardForm.NextButton.Enabled := True;
    Exit;
  end;
  if not RunFreshHelper('--fresh-reinstall-remove', ExitCode) then
  begin
    FreshStatus.Font.Color := clRed;
    FreshStatus.Caption := 'Windows could not start Chrome cleanup. Select Try again.';
    WizardForm.NextButton.Caption := 'Try again';
    WizardForm.NextButton.Enabled := True;
    Exit;
  end;
  if ExitCode = 0 then
  begin
    FreshRemovalReady := True;
    FreshStatus.Font.Color := clGreen;
    FreshStatus.Caption := 'Chrome extension removed. Setup can continue.';
    Result := True;
  end
  else if ExitCode = 4 then
  begin
    FreshManualRequired := True;
    FreshSummary.Caption := 'Chrome needs one manual Remove click.';
    FreshSteps.Caption :=
      '• In the Chrome profile that has OFEnhancer, open chrome://extensions.' + #13#10 +
      '• Find Creator Workflow Toolkit / OFEnhancer.' + #13#10 +
      '• Click Remove — not Reload.' + #13#10 +
      '• Wait until its card disappears.' + #13#10 +
      '• Return here and select Verify removal.';
    FreshStatus.Font.Color := clWindowText;
    FreshStatus.Caption := 'Waiting for you. Your desktop files and data are still untouched.';
    WizardForm.NextButton.Caption := 'Verify removal';
  end
  else
  begin
    FreshStatus.Font.Color := clRed;
    FreshStatus.Caption := 'Chrome cleanup stopped safely. Select Try again, or Cancel to leave everything unchanged.';
    WizardForm.NextButton.Caption := 'Try again';
  end;
  WizardForm.NextButton.Enabled := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if not IsFreshReset() then Exit;
  if not FreshRemovalReady then
  begin
    if not ExtractFreshMaintenance() then
    begin
      Result := 'Fresh reinstall could not start Chrome cleanup. No old state was changed.';
      Exit;
    end;
    if not RunFreshHelper('--fresh-reinstall-remove', ExitCode) or (ExitCode <> 0) then
    begin
      Result := 'Chrome removal still needs attention. Return to the Chrome removal page and follow its steps.';
      Exit;
    end;
    FreshRemovalReady := True;
  end;
  if ExistingInstall() then
  begin
    if not ValidExistingUninstaller() then
    begin
      Result := 'The registered previous uninstaller does not belong to the verified OFEnhancer install root. Cleanup was blocked.';
      Exit;
    end;
    if not Exec('>', ExistingUninstaller + ' /SILENT /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    begin
      Result := 'The verified previous OFEnhancer uninstaller failed. The Fresh transaction was preserved.';
      Exit;
    end;
  end;
  if not RunFreshHelper('--fresh-reinstall-clean', ExitCode) or (ExitCode <> 0) then
    Result := 'OFEnhancer could not purge every verified owned file or cache. Setup stopped and preserved the resumable Fresh transaction.';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result :=
    (KeepDataPage <> nil) and
    (PageID = KeepDataPage.ID) and
    (ExistingPage.SelectedValueIndex <> 2);
  if (FreshPage <> nil) and (PageID = FreshPage.ID) then
    Result := not IsFreshReset();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (FreshPage <> nil) and (CurPageID = FreshPage.ID) then
  begin
    if FreshManualRequired then
      WizardForm.NextButton.Caption := 'Verify removal'
    else
      WizardForm.NextButton.Caption := 'Remove and continue';
  end
  else
    WizardForm.NextButton.Caption := SetupMessage(msgButtonNext);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if (FreshPage <> nil) and (CurPageID = FreshPage.ID) then
  begin
    Result := RunChromeRemovalStep();
    Exit;
  end;
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
